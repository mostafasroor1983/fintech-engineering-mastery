package com.fintechmastery.recon;

public class StatementRejectedException extends RuntimeException {

    public StatementRejectedException(String message) {
        super(message);
    }

    public StatementRejectedException(String message, Throwable cause) {
        super(message, cause);
    }
}
