package tide.cards;

import tide.platform.http.BankHttp;

/** Every team calls through the platform team's wrapper; the URL comes from a service id. */
public class AuditClient {
  private final BankHttp bankHttp;

  public void record(AuditEvent e) {
    bankHttp.exchange(Services.AUDIT, "POST", "/audit/events", e);
  }
}
