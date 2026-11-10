package forge.teller;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.client.RestClient;

public class RatesClient {
  @Value("${fx.gateway-url}") private String fxGateway;
  private final RestClient http;

  public RatesClient(RestClient http) { this.http = http; }

  public Rates rates() {
    return http.get().uri(fxGateway + "/forge/fx/v1/rates").retrieve().body(Rates.class);
  }

  public Cached cached(String key) {
    return http.get().uri("http://rates-cache:8080/cache/" + key).retrieve().body(Cached.class);
  }
}
