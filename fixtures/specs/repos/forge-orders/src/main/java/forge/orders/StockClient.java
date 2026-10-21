package forge.orders;

public class StockClient {
  private final HttpClient http;

  public void reserve(String sku, int quantity) {
    http.post("/stock/reservations", Map.of("sku", sku, "quantity", quantity));
  }
}
