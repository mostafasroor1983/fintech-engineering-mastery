package com.fintechmastery.sb4.lesson01;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication
@ConfigurationPropertiesScan
public class Lesson01Application {

    public static void main(String[] args) {
        SpringApplication.run(Lesson01Application.class, args);
    }
}
