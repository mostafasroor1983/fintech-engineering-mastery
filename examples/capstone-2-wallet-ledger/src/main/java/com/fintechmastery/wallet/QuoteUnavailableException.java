package com.fintechmastery.wallet;

public class QuoteUnavailableException extends RuntimeException {

    public QuoteUnavailableException() {
        super("FX quote is expired, already used, or does not exist");
    }
}
