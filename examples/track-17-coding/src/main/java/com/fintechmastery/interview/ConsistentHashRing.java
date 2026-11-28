package com.fintechmastery.interview;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Map;
import java.util.SortedMap;
import java.util.TreeMap;

/**
 * C09: consistent hashing with virtual nodes, to spread accounts over partitions or cache nodes.
 *
 * <p>Each physical node owns {@code virtualNodes} points on a 64-bit ring. A key belongs to the first
 * point clockwise from its hash. Adding or removing one of N nodes moves only about 1/N of the keys,
 * where {@code hash % N} would move almost all of them.
 */
public final class ConsistentHashRing {

    private final int virtualNodes;
    private final TreeMap<Long, String> ring = new TreeMap<>();

    public ConsistentHashRing(int virtualNodes) {
        if (virtualNodes < 1) throw new IllegalArgumentException("virtualNodes must be >= 1");
        this.virtualNodes = virtualNodes;
    }

    public synchronized void addNode(String node) {
        for (int i = 0; i < virtualNodes; i++) {
            String previous = ring.putIfAbsent(hash(node + "#" + i), node);
            if (previous != null && !previous.equals(node)) {
                throw new IllegalStateException("hash collision between " + previous + " and " + node);
            }
        }
    }

    public synchronized void removeNode(String node) {
        for (int i = 0; i < virtualNodes; i++) ring.remove(hash(node + "#" + i), node);
    }

    public synchronized String nodeFor(String key) {
        if (ring.isEmpty()) throw new IllegalStateException("no nodes");
        SortedMap<Long, String> tail = ring.tailMap(hash(key));
        return tail.isEmpty() ? ring.firstEntry().getValue() : tail.get(tail.firstKey());  // wrap around
    }

    public synchronized Map<Long, String> snapshot() {
        return Map.copyOf(ring);
    }

    /** First 8 bytes of SHA-256: stable across JVMs and runs, unlike String.hashCode distribution. */
    static long hash(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
            return ByteBuffer.wrap(d, 0, 8).getLong();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);   // every JVM must provide SHA-256
        }
    }
}
