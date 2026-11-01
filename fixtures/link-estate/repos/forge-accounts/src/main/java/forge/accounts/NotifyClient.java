package forge.accounts;

import forge.starter.http.ForgeRestClient;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class NotifyClient {
  private final ForgeRestClient http;

  public NotifyClient(@Value("${forge.notify.base-url}") String base) {
    this.http = ForgeRestClient.forBase(base);
  }

  public void debited(DebitView debit) {
    http.post("/notifications", NotificationRequest.debited(debit), Void.class);
  }
}
