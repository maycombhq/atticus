package forge.billing;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.client.RestClient;

public class NorthwindClient {
  private final RestClient http;

  public NorthwindClient(RestClient.Builder builder, @Value("${forge.partner.base-url}") String base) {
    this.http = builder.baseUrl(base).build();
  }

  public ChargeView charge(ChargeRequest body) {
    return http.post().uri("/partners/northwind/charges").body(body).retrieve().body(ChargeView.class);
  }
}
