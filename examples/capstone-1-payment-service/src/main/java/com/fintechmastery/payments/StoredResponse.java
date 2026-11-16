package com.fintechmastery.payments;

/** What the API returns: either a fresh result or the replay of the first one. */
public record StoredResponse(int status, String body, boolean replayed) {
}
