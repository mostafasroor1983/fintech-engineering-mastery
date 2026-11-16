package com.fintechmastery.p2p;

import java.time.Duration;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.dao.DataAccessException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.stereotype.Component;

/**
 * Per-tenant token bucket shared by all app instances (state lives in Redis; the Lua script makes
 * read-refill-take atomic). One tenant's burst cannot starve the others ("noisy neighbour").
 */
@Component
public class TenantRateLimiter {

    private static final Logger log = LoggerFactory.getLogger(TenantRateLimiter.class);

    @SuppressWarnings("rawtypes")
    private final RedisScript<List> script = RedisScript.of(new ClassPathResource("scripts/token_bucket.lua"), List.class);
    private final StringRedisTemplate redis;
    private final P2pProperties.RateLimit config;

    public TenantRateLimiter(StringRedisTemplate redis, P2pProperties props) {
        this.redis = redis;
        this.config = props.rateLimit();
    }

    /** Takes one token or throws {@link RateLimitedException} with the time until the next token. */
    public void acquire(String tenantId) {
        P2pProperties.Tier tier = config.tierFor(tenantId);
        List<?> result;
        try {
            result = redis.execute(script, List.of("rl:{" + tenantId + "}"),
                    String.valueOf(tier.capacity()), String.valueOf(tier.refillPerSecond()));
        } catch (DataAccessException redisDown) {
            if (config.failOpen()) {
                log.warn("Rate limiter unavailable, failing open: {}", redisDown.getClass().getSimpleName());
                return;
            }
            throw new RateLimitedException(Duration.ofSeconds(1));
        }
        if (((Number) result.get(0)).longValue() != 1L) {
            throw new RateLimitedException(Duration.ofMillis(((Number) result.get(1)).longValue()));
        }
    }
}
