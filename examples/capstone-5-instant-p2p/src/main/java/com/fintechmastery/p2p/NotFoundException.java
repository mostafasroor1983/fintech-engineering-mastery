package com.fintechmastery.p2p;

/** Used for "does not exist" AND "exists but is not yours": never reveal other tenants' resources. */
public class NotFoundException extends RuntimeException {

    public NotFoundException(String what) {
        super(what + " not found");
    }
}
