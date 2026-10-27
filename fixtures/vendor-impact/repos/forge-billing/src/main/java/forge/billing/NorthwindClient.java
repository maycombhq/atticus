package forge.billing;

import java.math.BigDecimal;
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

  public ChargeView capture(String chargeId) {
    return http.post().uri("/partners/northwind/charges/{chargeId}/capture", chargeId).retrieve().body(ChargeView.class);
  }

  public RefundView refund(String chargeId, BigDecimal amount) {
    return http.post().uri("/partners/northwind/charges/{chargeId}/refunds", chargeId).body(new RefundBody(amount)).retrieve().body(RefundView.class);
  }
}
