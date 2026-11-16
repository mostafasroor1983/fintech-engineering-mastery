package com.fintechmastery.sb4.lesson02;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.resilience.annotation.EnableResilientMethods;
import org.springframework.web.service.registry.ImportHttpServices;

@SpringBootApplication
@EnableResilientMethods                                       // turns on @Retryable / @ConcurrencyLimit
@ImportHttpServices(group = "psp", types = PspClient.class)   // Spring creates the client from the interface
public class Lesson02Application {

    public static void main(String[] args) {
        SpringApplication.run(Lesson02Application.class, args);
    }
}
