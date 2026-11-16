package com.fintechmastery.p2p;

import java.net.InetAddress;
import java.net.URI;
import java.net.UnknownHostException;
import org.springframework.stereotype.Component;

/**
 * Webhook URLs come from tenants, so they are an SSRF risk (OWASP API7): a tenant could point us at
 * http://169.254.169.254 (cloud metadata) or an internal service. Rules: https only, no private,
 * loopback, link-local or multicast targets. Redirects are not followed by the dispatcher.
 *
 * <p>Known gap: DNS can change after validation (DNS rebinding). A production system re-checks the
 * resolved IP at connect time or sends webhooks through an egress proxy that enforces the rules.
 */
@Component
public class WebhookUrlValidator {

    private final boolean allowInsecureLocalhost;

    public WebhookUrlValidator(P2pProperties props) {
        this.allowInsecureLocalhost = props.webhooks().allowInsecureLocalhost();
    }

    public URI validate(String raw) {
        URI uri;
        try {
            uri = URI.create(raw);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("Webhook URL is not a valid URI");
        }
        if (uri.getHost() == null || uri.getUserInfo() != null) {
            throw new IllegalArgumentException("Webhook URL must have a host and no credentials");
        }
        InetAddress[] addresses;
        try {
            addresses = InetAddress.getAllByName(uri.getHost());
        } catch (UnknownHostException e) {
            throw new IllegalArgumentException("Webhook host does not resolve");
        }
        boolean allLoopback = true;
        for (InetAddress a : addresses) {
            allLoopback &= a.isLoopbackAddress();
            boolean internal = a.isLoopbackAddress() || a.isSiteLocalAddress() || a.isLinkLocalAddress()
                    || a.isAnyLocalAddress() || a.isMulticastAddress();
            if (internal && !(allowInsecureLocalhost && a.isLoopbackAddress())) {
                throw new IllegalArgumentException("Webhook URL points to an internal address");
            }
        }
        boolean devLoopback = allowInsecureLocalhost && allLoopback && "http".equals(uri.getScheme());
        if (!"https".equals(uri.getScheme()) && !devLoopback) {
            throw new IllegalArgumentException("Webhook URL must use https");
        }
        return uri;
    }
}
