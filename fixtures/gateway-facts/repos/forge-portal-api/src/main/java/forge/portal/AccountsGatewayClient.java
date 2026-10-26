package forge.portal;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/** The portal's calls to the accounts service, through the Forge API gateway. */
@Component
public class AccountsGatewayClient {
  private final RestClient http;

  public AccountsGatewayClient(@Value("${forge.gateway.base-url}") String baseUrl) {
    this.http = RestClient.builder().baseUrl(baseUrl).build();
  }

  public AccountView account(String id) {
    return http.get().uri("/forge/v1/accounts/{id}", id).retrieve().body(AccountView.class);
  }

  public TransferView transfer(String id, TransferRequest body) {
    return http.post()
        .uri("/forge/v1/accounts/{id}/transfers", id)
        .body(body)
        .retrieve()
        .body(TransferView.class);
  }
}
