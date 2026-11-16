package com.fintechmastery.sb4.lesson02;

import java.util.UUID;
import org.springframework.resilience.annotation.Retryable;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpServerErrorException;
import org.springframework.web.client.ResourceAccessException;

/**
 * Retrying a POST is only safe if the server can recognise the retry. The key must be created
 * ONCE, before the retry loop, so every attempt carries the same key.
 */
@Service
public class ChargeGateway {

    private final PspClient psp;

    public ChargeGateway(PspClient psp) {
        this.psp = psp;
    }

    /** BUG: a fresh key per attempt, so the PSP sees every retry as a new charge. */
    @Retryable(includes = {HttpServerErrorException.class, ResourceAccessException.class},
            maxRetries = 2, delay = 50, jitter = 10, multiplier = 2)
    public PspClient.ChargeResponse chargeUnsafe(PspClient.ChargeRequest request) {
        return psp.charge(UUID.randomUUID().toString(), request);
    }

    /** FIX: the caller supplies the key; @Retryable re-invokes with the same arguments. */
    @Retryable(includes = {HttpServerErrorException.class, ResourceAccessException.class},
            maxRetries = 2, delay = 50, jitter = 10, multiplier = 2)
    public PspClient.ChargeResponse charge(String idempotencyKey, PspClient.ChargeRequest request) {
        return psp.charge(idempotencyKey, request);
    }
}
