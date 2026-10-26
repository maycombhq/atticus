package forge.orders;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/** The orders service's call to Northwind Pay, on its way out through the Forge gateways. */
@Component
public class PayGatewayClient {
  private final RestClient http;

  public PayGatewayClient(@Value("${forge.edge.base-url}") String baseUrl) {
    this.http = RestClient.builder().baseUrl(baseUrl).build();
  }

  public ChargeView charge(ChargeRequest body) {
    return http.post().uri("/forge/pay/v1/charges").body(body).retrieve().body(ChargeView.class);
  }
}
