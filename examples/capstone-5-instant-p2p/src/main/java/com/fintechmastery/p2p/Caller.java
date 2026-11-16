package com.fintechmastery.p2p;

import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

/** Who is calling. Tenant and user come ONLY from the verified token, never from headers or the body. */
public record Caller(String tenantId, String userId) {

    static Caller from(Authentication auth) {
        if (!(auth instanceof JwtAuthenticationToken token)) {
            throw new AccessDeniedException("JWT required");
        }
        Jwt jwt = token.getToken();
        String tenant = jwt.getClaimAsString("tenant_id");
        if (tenant == null || tenant.isBlank()) {
            throw new AccessDeniedException("Token has no tenant");
        }
        return new Caller(tenant, jwt.getSubject());
    }
}
