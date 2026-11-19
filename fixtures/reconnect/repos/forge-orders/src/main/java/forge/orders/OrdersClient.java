package forge.orders;

public class OrdersClient {
  private final Http http;
  private final Object billingClient;

  // By its address: the host is forge-billing's.
  Object call0(Object id, Object e, Object c) { return http.get("https://billing.forge.example/holds/{id}", id); }
  // The assistant's fact names forge-billing.
  Object call1(Object id, Object e, Object c) { return http.post(billingClient, "/holds/{id}/release", id); }
  // A host nothing names: asked about.
  Object call2(Object id, Object e, Object c) { return http.get("https://fees.forge.internal/fees/{id}", id); }
  // A deploy token nothing sets: loose until somebody pairs it.
  Object call3(Object id, Object e, Object c) { return http.get("@forgeBooksUrl@/entries/{id}", id); }
  // The same.
  Object call4(Object id, Object e, Object c) { return http.post("@forgeBooksUrl@/entries", e); }
  // Through the gateway.
  Object call5(Object id, Object e, Object c) { return http.get("https://gw.forge.example/billing/v1/statements/{id}", id); }
  // A vendor's.
  Object call6(Object id, Object e, Object c) { return http.post("https://api.northwind.example/charges", c); }
}
