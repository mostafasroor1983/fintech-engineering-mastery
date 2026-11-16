package com.fintechmastery.recon;

import com.fintechmastery.common.Money;
import java.io.ByteArrayInputStream;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import javax.xml.stream.XMLInputFactory;
import javax.xml.stream.XMLStreamConstants;
import javax.xml.stream.XMLStreamException;
import javax.xml.stream.XMLStreamReader;

/**
 * Streaming parser for the subset of ISO 20022 camt.053 (Bank-to-Customer Statement) we need.
 * Works with any camt.053.001.xx namespace because it matches on local element names.
 *
 * <p>Security: DTDs and external entities are disabled, so XXE ("billion laughs", file
 * disclosure) payloads fail instead of being expanded. Bank files are untrusted input.
 *
 * <p>Limits (documented in the README): one statement per file, one TxDtls per entry (no batch
 * bookings), balances OPBD and CLBD only.
 */
public final class Camt053Parser {

    private final XMLInputFactory factory;

    public Camt053Parser() {
        factory = XMLInputFactory.newFactory();
        factory.setProperty(XMLInputFactory.SUPPORT_DTD, false);
        factory.setProperty(XMLInputFactory.IS_SUPPORTING_EXTERNAL_ENTITIES, false);
    }

    public Statement parse(byte[] xml) {
        try {
            return doParse(xml);
        } catch (XMLStreamException | RuntimeException e) {
            if (e instanceof StatementRejectedException sre) {
                throw sre;
            }
            throw new StatementRejectedException("Malformed camt.053 file", e);
        }
    }

    private Statement doParse(byte[] xml) throws XMLStreamException {
        XMLStreamReader r = factory.createXMLStreamReader(new ByteArrayInputStream(xml));
        Deque<String> path = new ArrayDeque<>();
        StringBuilder text = new StringBuilder();
        Map<String, String> stmt = new HashMap<>();
        Map<String, String> bal = new HashMap<>();
        Map<String, String> ntry = new HashMap<>();
        Map<String, String> balances = new HashMap<>(); // "OPBD" -> "1000.00|CRDT|GBP"
        List<Map<String, String>> entries = new ArrayList<>();

        while (r.hasNext()) {
            int event = r.next();
            switch (event) {
                case XMLStreamConstants.START_ELEMENT -> {
                    path.addLast(r.getLocalName());
                    text.setLength(0);
                    String ccy = r.getAttributeValue(null, "Ccy");
                    if (ccy != null) {
                        (inside(path, "Ntry") ? ntry : inside(path, "Bal") ? bal : stmt).put(rel(path) + "@Ccy", ccy);
                    }
                }
                case XMLStreamConstants.CHARACTERS -> text.append(r.getText());
                case XMLStreamConstants.END_ELEMENT -> {
                    String value = text.toString().trim();
                    String p = rel(path);
                    if (inside(path, "Ntry")) {
                        if (!value.isEmpty()) {
                            ntry.put(p, value);
                        }
                        if (r.getLocalName().equals("Ntry")) {
                            entries.add(new HashMap<>(ntry));
                            ntry.clear();
                        }
                    } else if (inside(path, "Bal")) {
                        if (!value.isEmpty()) {
                            bal.put(p, value);
                        }
                        if (r.getLocalName().equals("Bal")) {
                            balances.put(bal.get("Tp/CdOrPrtry/Cd"),
                                    bal.get("Amt") + "|" + bal.get("CdtDbtInd") + "|" + bal.get("Amt@Ccy"));
                            bal.clear();
                        }
                    } else if (inside(path, "Stmt") && !value.isEmpty()) {
                        stmt.put(p, value);
                    }
                    path.removeLast();
                    text.setLength(0);
                }
                default -> {
                    // comments, whitespace, processing instructions: ignored
                }
            }
        }

        String iban = require(stmt, "Acct/Id/IBAN");
        String currency = require(stmt, "Acct/Ccy");
        Money opening = balance(balances.get("OPBD"), currency, "OPBD");
        Money closing = balance(balances.get("CLBD"), currency, "CLBD");
        List<BankLine> lines = entries.stream().map(e -> line(e, currency)).toList();
        Statement s = new Statement(require(stmt, "Id"), iban, currency,
                OffsetDateTime.parse(require(stmt, "CreDtTm")).toLocalDate(), opening, closing, lines);
        checkBalances(s);
        return s;
    }

    /** opening + credits - debits must equal closing. If not, the file is corrupt or incomplete. */
    static void checkBalances(Statement s) {
        Money running = s.opening();
        for (BankLine l : s.lines()) {
            running = l.direction() == Direction.CRDT ? running.plus(l.amount()) : running.minus(l.amount());
        }
        if (!running.equals(s.closing())) {
            throw new StatementRejectedException("Statement does not balance: opening + entries = " + running
                    + " but closing = " + s.closing());
        }
    }

    private static BankLine line(Map<String, String> e, String currency) {
        String ccy = require(e, "Amt@Ccy");
        if (!ccy.equals(currency)) {
            throw new StatementRejectedException("Entry currency " + ccy + " differs from account currency");
        }
        String e2e = e.get("NtryDtls/TxDtls/Refs/EndToEndId");
        if ("NOTPROVIDED".equals(e2e)) {
            e2e = null;
        }
        return new BankLine(require(e, "AcctSvcrRef"), e2e, Money.of(new BigDecimal(require(e, "Amt")), ccy),
                Direction.valueOf(require(e, "CdtDbtInd")), LocalDate.parse(require(e, "ValDt/Dt")),
                e.get("NtryDtls/TxDtls/RmtInf/Ustrd"));
    }

    private static Money balance(String encoded, String currency, String type) {
        if (encoded == null) {
            throw new StatementRejectedException("Missing " + type + " balance");
        }
        String[] parts = encoded.split("\\|");
        Money m = Money.of(new BigDecimal(parts[0]), currency);
        return "DBIT".equals(parts[1]) ? m.negate() : m;
    }

    private static String require(Map<String, String> fields, String key) {
        String v = fields.get(key);
        if (v == null || v.isBlank()) {
            throw new StatementRejectedException("Missing element " + key);
        }
        return v;
    }

    private static boolean inside(Deque<String> path, String element) {
        return path.contains(element);
    }

    /** Path relative to the innermost Ntry, Bal or Stmt element, e.g. "NtryDtls/TxDtls/Refs/EndToEndId". */
    private static String rel(Deque<String> path) {
        List<String> parts = new ArrayList<>(path);
        int start = Math.max(Math.max(parts.lastIndexOf("Ntry"), parts.lastIndexOf("Bal")), parts.lastIndexOf("Stmt"));
        return String.join("/", parts.subList(start + 1, parts.size()));
    }
}
