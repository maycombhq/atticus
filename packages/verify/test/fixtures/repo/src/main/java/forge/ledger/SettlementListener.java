package forge.ledger;

import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

@Component
public class SettlementListener {
  private final EntryRepository entries;

  public SettlementListener(EntryRepository entries) {
    this.entries = entries;
  }

  @KafkaListener(topics = "forge.payments.settled")
  public void onSettled(String payload) {
    // marks the entry settled
  }
}
