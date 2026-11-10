package forge.payments.common;

import org.springframework.web.client.RestClient;

public class NorthwindFxClient {
  private final RestClient http = RestClient.create("https://fx.northwind.example");

  public String rate(String pair) {
    return http.get().uri("/rates/{pair}", pair).retrieve().body(String.class);
  }
}
