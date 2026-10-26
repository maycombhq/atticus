package forge.shop;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/** The shop's calls to the orders service, through the Forge edge gateway. */
@Component
public class OrdersGatewayClient {
  private final RestClient http;

  public OrdersGatewayClient(@Value("${forge.edge.base-url}") String baseUrl) {
    this.http = RestClient.builder().baseUrl(baseUrl).build();
  }

  public OrderView order(String id) {
    return http.get().uri("/forge/v2/orders/{id}", id).retrieve().body(OrderView.class);
  }

  public DispatchView dispatch(String id, DispatchRequest body) {
    return http.post()
        .uri("/forge/v2/orders/{id}/dispatch", id)
        .body(body)
        .retrieve()
        .body(DispatchView.class);
  }
}
