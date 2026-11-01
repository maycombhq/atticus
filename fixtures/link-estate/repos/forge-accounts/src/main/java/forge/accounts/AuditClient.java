package forge.accounts;

import forge.starter.http.ForgeRestClient;
import org.springframework.stereotype.Component;

@Component
public class AuditClient {
  private final ForgeRestClient http = ForgeRestClient.forService("audit-gw");

  public void record(DebitView debit) {
    http.post("/events", AuditEvent.of(debit), Void.class);
  }
}
