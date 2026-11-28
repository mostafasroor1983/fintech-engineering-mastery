package com.fintechmastery.interview;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;

/**
 * C03: thread-safe transfers between in-memory accounts, with no deadlock and no negative balance.
 *
 * <p>Two transfers in opposite directions (A to B, B to A) deadlock if each locks its source first.
 * Locking both accounts in a global order (here: by id) makes a cycle impossible.
 */
public final class TransferService {

    private static final class Account {
        final String id;
        final ReentrantLock lock = new ReentrantLock();
        long balanceMinor;                       // guarded by lock

        Account(String id, long balanceMinor) {
            this.id = id;
            this.balanceMinor = balanceMinor;
        }
    }

    private final Map<String, Account> accounts = new ConcurrentHashMap<>();

    public void open(String id, long initialMinor) {
        if (initialMinor < 0) throw new IllegalArgumentException("negative opening balance");
        if (accounts.putIfAbsent(id, new Account(id, initialMinor)) != null) {
            throw new IllegalArgumentException("account exists: " + id);
        }
    }

    public void transfer(String fromId, String toId, long amountMinor) {
        if (amountMinor <= 0) throw new IllegalArgumentException("amount must be positive");
        if (fromId.equals(toId)) throw new IllegalArgumentException("same account");
        Account from = require(fromId);
        Account to = require(toId);

        // Global lock order by id: every thread locks the "smaller" account first
        Account first = from.id.compareTo(to.id) < 0 ? from : to;
        Account second = first == from ? to : from;

        first.lock.lock();
        try {
            second.lock.lock();
            try {
                if (from.balanceMinor < amountMinor) {
                    throw new InsufficientFundsException(fromId);
                }
                from.balanceMinor -= amountMinor;
                to.balanceMinor += amountMinor;
            } finally {
                second.lock.unlock();
            }
        } finally {
            first.lock.unlock();
        }
    }

    public long balance(String id) {
        Account a = require(id);
        a.lock.lock();
        try {
            return a.balanceMinor;
        } finally {
            a.lock.unlock();
        }
    }

    private Account require(String id) {
        Account a = accounts.get(id);
        if (a == null) throw new IllegalArgumentException("unknown account: " + id);
        return a;
    }

    public static final class InsufficientFundsException extends RuntimeException {
        public InsufficientFundsException(String accountId) {
            super("insufficient funds in " + accountId);
        }
    }
}
