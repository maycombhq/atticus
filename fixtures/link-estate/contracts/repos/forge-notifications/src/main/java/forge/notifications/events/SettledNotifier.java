package forge.notifications.events;

import forge.payments.v1.PaymentSettled;
import org.springframework.kafka.annotation.KafkaListener;

public class SettledNotifier {
  @KafkaListener(topics = "forge.payments.settled")
  public void notify(PaymentSettled event) {
    mail.paid(event.getPaymentId(), event.getAmountMinor(), event.getCurrency());
  }
}
