package forge.accounts;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.client.RestClient;

public class NorthwindAccountsClient {
  @Value("${vendor.base-url}") private String base;
  @Value("${vendor.paths.account}") private String account;
  @Value("${vendor.paths.account-status}") private String accountStatus;
  private final RestClient http;

  public NorthwindAccountsClient(RestClient http) { this.http = http; }

  public Account get(String id) {
    return http.get().uri(base + account, id).retrieve().body(Account.class);
  }

  public Account update(String id, Account body) {
    return http.put().uri(base + account, id).body(body).retrieve().body(Account.class);
  }

  public Account status(String id, Status body) {
    return http.post().uri(base + accountStatus, id).body(body).retrieve().body(Account.class);
  }
}
