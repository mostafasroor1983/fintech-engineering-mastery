package com.fintechmastery.p2p;

import com.fintechmastery.common.Hashing;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

/** A customer's webhook endpoint: verifies the signature like a real receiver would. */
final class WebhookReceiver {

    private final HttpServer server;
    volatile String secret = "";
    volatile int failFirst = 0;
    final AtomicInteger requests = new AtomicInteger();
    final List<String> verifiedIds = new CopyOnWriteArrayList<>();
    final List<String> badSignatures = new CopyOnWriteArrayList<>();

    WebhookReceiver() {
        try {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        server.createContext("/hook", ex -> {
            int n = requests.incrementAndGet();
            String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            String id = ex.getRequestHeaders().getFirst("Webhook-Id");
            String ts = ex.getRequestHeaders().getFirst("Webhook-Timestamp");
            String sig = ex.getRequestHeaders().getFirst("Webhook-Signature");
            String expected = "v1=" + Hashing.hmacSha256Hex(secret.getBytes(StandardCharsets.UTF_8), id + "." + ts + "." + body);
            int status;
            if (!Hashing.constantTimeEquals(expected, sig == null ? "" : sig)) {
                badSignatures.add(id);
                status = 401;
            } else if (n <= failFirst) {
                status = 503;
            } else {
                verifiedIds.add(id);
                status = 204;
            }
            ex.sendResponseHeaders(status, -1);
            ex.close();
        });
        server.start();
    }

    String url() {
        return "http://127.0.0.1:" + server.getAddress().getPort() + "/hook";
    }

    void reset(int failFirst) {
        this.failFirst = failFirst;
        requests.set(0);
        verifiedIds.clear();
        badSignatures.clear();
    }
}
