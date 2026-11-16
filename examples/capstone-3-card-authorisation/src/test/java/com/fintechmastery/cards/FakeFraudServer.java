package com.fintechmastery.cards;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/** A real HTTP server (JDK built-in) so timeouts and connection errors are real, not mocked. */
final class FakeFraudServer {

    enum Mode { SCORE, SLOW, ERROR }

    private final HttpServer server;
    volatile Mode mode = Mode.SCORE;
    volatile int score = 10;
    volatile long slowMillis = 1_000;
    final AtomicInteger calls = new AtomicInteger();

    FakeFraudServer() {
        try {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/v1/score", exchange -> {
            calls.incrementAndGet();
            exchange.getRequestBody().readAllBytes();
            try {
                switch (mode) {
                    case SLOW -> {
                        Thread.sleep(slowMillis);
                        respond(exchange, 200, "{\"score\":" + score + "}");
                    }
                    case ERROR -> respond(exchange, 503, "{}");
                    case SCORE -> respond(exchange, 200, "{\"score\":" + score + "}");
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } catch (IOException ignored) {
                // client gave up (timeout): expected in the SLOW scenario
            }
        });
        server.start();
    }

    private static void respond(com.sun.net.httpserver.HttpExchange ex, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/json");
        ex.sendResponseHeaders(status, bytes.length);
        try (var out = ex.getResponseBody()) {
            out.write(bytes);
        }
    }

    String url() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    void reset() {
        mode = Mode.SCORE;
        score = 10;
        slowMillis = 1_000;
        calls.set(0);
    }
}
