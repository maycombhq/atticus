package tide.cards;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.client.RestTemplate;

public class PaymentsGateway {
  private static final String PAY = "/v2/payments";

  @Value("${tide.endpoints.payments}")
  private String base;

  private final RestTemplate restTemplate = new RestTemplate();

  public Receipt pay(Payment p) {
    return restTemplate.postForObject(base + PAY, p, Receipt.class);
  }

  /** The partner bank's own API happens to sit on the same basepath as our gateway route. */
  public Receipt partner(Payment p) {
    return restTemplate.postForObject("https://api.partner-bank.example/payments-api/v2/payments", p, Receipt.class);
  }

  public String health() {
    return restTemplate.getForObject("/health", String.class);
  }
}
