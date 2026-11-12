package forge.checkout;

import org.springframework.web.client.RestClient;

public class NorthwindPayClient {
  private final RestClient http;

  public NorthwindPayClient(RestClient http) { this.http = http; }

  public Payment payment(String id) {
    return http.get().uri("/northwind-pay/1.0/payments/{id}", id).retrieve().body(Payment.class);
  }

  public Refund refund(String id) {
    return http.get().uri("/northwind-pay/1.0/refunds/{id}", id).retrieve().body(Refund.class);
  }
}
