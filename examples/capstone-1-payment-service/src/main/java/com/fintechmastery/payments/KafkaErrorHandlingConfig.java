package com.fintechmastery.payments;

import org.apache.kafka.common.TopicPartition;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.core.KafkaOperations;
import org.springframework.kafka.listener.DeadLetterPublishingRecoverer;
import org.springframework.kafka.listener.DefaultErrorHandler;
import org.springframework.util.backoff.FixedBackOff;

/**
 * A poison message must not block the partition forever: retry 3 times, then park it on
 * "<topic>-dlt" for a human. Boot wires a single CommonErrorHandler bean into the listener factory.
 */
@Configuration(proxyBeanMethods = false)
class KafkaErrorHandlingConfig {

    @Bean
    DefaultErrorHandler kafkaErrorHandler(KafkaOperations<Object, Object> template) {
        // Explicit DLT name; partition -1 lets Kafka choose, so the DLT needs no matching partition count.
        var recoverer = new DeadLetterPublishingRecoverer(template,
                (record, ex) -> new TopicPartition(record.topic() + "-dlt", -1));
        return new DefaultErrorHandler(recoverer, new FixedBackOff(500L, 3));
    }
}
