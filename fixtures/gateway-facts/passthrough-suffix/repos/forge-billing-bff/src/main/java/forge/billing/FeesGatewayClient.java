package forge.billing;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/** The billing screens' calls to the fees service, through the Forge API gateway. */
@Component
public class FeesGatewayClient {
  private final RestClient http;

  public FeesGatewayClient(@Value("${forge.gateway.base-url}") String baseUrl) {
    this.http = RestClient.builder().baseUrl(baseUrl).build();
  }

  public FeeList fees(String account) {
    return http.get().uri("/forge/fees/v1/retrieve?account={a}", account).retrieve().body(FeeList.class);
  }
}
