package forge.house.client;

import forge.house.model.ListingRequest;
import forge.house.model.ValuationResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.client.RestTemplate;

public class ValuationClient {
  private final RestTemplate rest = new RestTemplate();

  @Value("${valuation.base-url}")
  private String baseUrl;

  public ValuationResponse quote(ListingRequest listing) {
    return rest.postForObject(baseUrl + "/v1/valuations", listing, ValuationResponse.class);
  }
}
