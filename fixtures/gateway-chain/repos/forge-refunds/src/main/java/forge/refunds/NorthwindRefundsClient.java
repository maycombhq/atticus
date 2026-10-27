package forge.refunds;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/** The refunds service's call to Northwind Pay, straight out through the partner gateway. */
@Component
public class NorthwindRefundsClient {
  private final RestClient http;

  public NorthwindRefundsClient(@Value("${forge.partner.base-url}") String baseUrl) {
    this.http = RestClient.builder().baseUrl(baseUrl).build();
  }

  public RefundView refund(VendorRefund body) {
    return http.post().uri("/pay/refunds/v1/refunds").body(body).retrieve().body(RefundView.class);
  }
}
