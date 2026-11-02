package forge.payments.events;

import forge.payments.v1.PaymentSettled;
import org.springframework.kafka.core.KafkaTemplate;

public class SettlementPublisher {
  private final KafkaTemplate<String, PaymentSettled> kafka;

  void settled(Settlement s) {
    PaymentSettled event = PaymentSettled.newBuilder()
        .setPaymentId(s.paymentId())
        .setAccountId(s.accountId())
        .setAmountMinor(s.amountMinor())
        .setCurrency(s.currency())
        .setSettledAt(s.settledAt().toString())
        .build();
    kafka.send("forge.payments.settled", s.paymentId(), event);
  }
}
