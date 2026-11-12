package forge.portal;

import org.springframework.kafka.core.KafkaTemplate;

public class PaymentEvents {
  private final KafkaTemplate<String, Object> kafka;

  public PaymentEvents(KafkaTemplate<String, Object> kafka) { this.kafka = kafka; }

  public void initiated(Object payment) {
    kafka.send("payments.initiated", payment);
  }
}
