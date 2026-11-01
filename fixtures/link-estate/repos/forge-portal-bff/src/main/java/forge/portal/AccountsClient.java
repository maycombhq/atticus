package forge.portal;

import forge.starter.http.ForgeRestClient;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class AccountsClient {
  private final ForgeRestClient http;

  public AccountsClient(@Value("${forge.gateway.base-url}") String base) {
    this.http = ForgeRestClient.forBase(base);
  }

  public AccountView account(String id) {
    return http.get("/forge/accounts/v1/accounts/{id}", AccountView.class, id);
  }
}
