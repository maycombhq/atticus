package forge.ledger;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

@Component
public class FxClient {
  private final RestTemplate rest;
  private final String base;

  public FxClient(RestTemplate rest, @Value("${fx.client.base-url}") String base) {
    this.rest = rest;
    this.base = base;
  }

  //
  //
  //
  //
  //
  //
  //
  //
  //
  //
  //
  //
  //
  public Rate rate(String pair) {
    return rest.getForObject(base + "/v1/rates/" + pair, Rate.class);
  }
}
