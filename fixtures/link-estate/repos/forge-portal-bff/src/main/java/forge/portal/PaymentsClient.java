package forge.portal;

import forge.starter.http.ForgeRestClient;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class PaymentsClient {
  private final ForgeRestClient http;

  public PaymentsClient(@Value("${forge.gateway.base-url}") String base) {
    this.http = ForgeRestClient.forBase(base);
  }

  public PaymentView pay(PaymentRequest req) {
    return http.post("/forge/payments/v1/payments", req, PaymentView.class);
  }

  public PaymentView status(String id) {
    return http.get("/forge/payments/v1/payments/{id}", PaymentView.class, id);
  }
}
