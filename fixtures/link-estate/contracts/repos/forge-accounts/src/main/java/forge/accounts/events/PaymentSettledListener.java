package forge.accounts.events;

import forge.payments.v1.PaymentSettled;
import org.springframework.kafka.annotation.KafkaListener;

public class PaymentSettledListener {
  @KafkaListener(topics = "forge.payments.settled")
  public void on(PaymentSettled event) {
    ledger.settle(event.getPaymentId(), event.getAccountId());
    ledger.post(event.getAmountMinor(), event.getFeeMinor());
  }
}
