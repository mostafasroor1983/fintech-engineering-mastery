package com.fintechmastery.p2p;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/** Runs after authentication (the security filter chain ran first), so the tenant is known and trusted. */
@Configuration(proxyBeanMethods = false)
class RateLimitInterceptor implements HandlerInterceptor, WebMvcConfigurer {

    private final TenantRateLimiter limiter;

    RateLimitInterceptor(TenantRateLimiter limiter) {
        this.limiter = limiter;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(this).addPathPatterns("/*/transfers", "/*/transfers/**");
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth != null && auth.isAuthenticated()) {
            limiter.acquire(Caller.from(auth).tenantId());
        }
        return true;
    }
}
