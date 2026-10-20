package harbor.orders;

import harbor.kit.http.Dock;
import harbor.kit.http.Systems;
import harbor.kit.web.Fetch;
import harbor.kit.web.HarborApi;

@HarborApi(root = "/orders")
public class OrdersApi {
  private final Dock dock;

  public OrdersApi(Dock dock) {
    this.dock = dock;
  }

  @Fetch("/{id}")
  public Order order(String id) {
    return null;
  }

  void place(Order o) {
    dock.send(Systems.LEDGER, "POST", "/ledger/entries", o);
    dock.relay(Systems.NOTIFY, "/notifications/orders", o);
  }
}
