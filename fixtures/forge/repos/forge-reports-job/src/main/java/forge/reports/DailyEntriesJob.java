package forge.reports;

import org.springframework.batch.core.Job;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.kafka.annotation.KafkaListener;

public class DailyEntriesJob {
  private final JdbcTemplate ledgerDb;

  public DailyEntriesJob(JdbcTemplate ledgerDb) { this.ledgerDb = ledgerDb; }

  // Reads the ledger's table directly. The diagram shows reports calling the Ledger API.
  public void run() {
    ledgerDb.query("SELECT account_id, amount, posted_at FROM entry WHERE posted_at >= ?", rs -> {});
  }

  @KafkaListener(topics = "transfers.completed")
  public void onTransferCompleted(Object transfer) { }
}
