package forge.wallet;

import org.springframework.web.client.RestClient;

public final class LedgerClient {
  private static final String BASE = "https://ledger.forge.internal";
  private final RestClient rest = RestClient.create(BASE);

  public Balance balance(String id) {
    return rest.get().uri("/accounts/{id}/balance", id).retrieve().body(Balance.class);
  }

  public void reverse(String id) {
    rest.post().uri("/accounts/{id}/reversals", id).retrieve().toBodilessEntity();
  }
}
