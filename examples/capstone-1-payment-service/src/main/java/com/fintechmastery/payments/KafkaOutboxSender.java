package com.fintechmastery.payments;

import java.util.concurrent.TimeUnit;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

@Component
class KafkaOutboxSender implements OutboxSender {

    private final KafkaTemplate<String, String> kafka;
    private final String topic;

    KafkaOutboxSender(KafkaTemplate<String, String> kafka, PaymentsProperties props) {
        this.kafka = kafka;
        this.topic = props.topic();
    }

    @Override
    public void send(String key, String payload) throws Exception {
        // Key = payment id, so all events of one payment land on one partition, in order.
        // Block for the ack (acks=all): we may only mark the row published after Kafka has it.
        kafka.send(topic, key, payload).get(10, TimeUnit.SECONDS);
    }
}
