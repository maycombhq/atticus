package forge.payments;

public class AccountsClient {
  private static final String ACCOUNTS = "https://api.forge.example/forge/accounts";

  public String account(String id) {
    return http.get(ACCOUNTS + "/" + id);
  }
}
