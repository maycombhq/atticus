package forge.payments;

public class LedgerClient {
  private final HttpClient http;

  public void post(LedgerEntryRequest entry) {
    http.post("/ledger/entries", entry);
  }
}
