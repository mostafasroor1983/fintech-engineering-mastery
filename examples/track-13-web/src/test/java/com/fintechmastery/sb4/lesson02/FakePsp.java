package com.fintechmastery.sb4.lesson02;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * A PSP that books the charge and THEN fails to answer (503) the first time: the worst case for
 * a client, because it cannot tell whether the charge happened. It honours Idempotency-Key.
 */
final class FakePsp {

    private final HttpServer server;
    final AtomicInteger requests = new AtomicInteger();
    final Map<String, String> chargesByKey = new ConcurrentHashMap<>();
    volatile int failFirst = 1;

    FakePsp() {
        try {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        server.createContext("/charges", ex -> {
            int n = requests.incrementAndGet();
            ex.getRequestBody().readAllBytes();
            String key = ex.getRequestHeaders().getFirst("Idempotency-Key");
            String id = chargesByKey.computeIfAbsent(key, k -> "ch_" + chargesByKey.size());
            byte[] body = n <= failFirst ? "{}".getBytes() :
                    ("{\"chargeId\":\"" + id + "\",\"status\":\"SUCCEEDED\"}").getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().add("Content-Type", "application/json");
            ex.sendResponseHeaders(n <= failFirst ? 503 : 200, body.length);
            ex.getResponseBody().write(body);
            ex.close();
        });
        server.start();
    }

    String url() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    void reset() {
        requests.set(0);
        chargesByKey.clear();
        failFirst = 1;
    }
}
