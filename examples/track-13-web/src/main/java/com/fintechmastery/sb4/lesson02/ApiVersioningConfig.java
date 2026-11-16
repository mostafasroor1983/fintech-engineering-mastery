package com.fintechmastery.sb4.lesson02;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.ApiVersionConfigurer;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/** Framework 7 built-in API versioning, read from a request header. */
@Configuration(proxyBeanMethods = false)
class ApiVersioningConfig implements WebMvcConfigurer {

    @Override
    public void configureApiVersioning(ApiVersionConfigurer configurer) {
        configurer.useRequestHeader("API-Version")
                .addSupportedVersions("1", "2")
                .setDefaultVersion("1");
    }
}
