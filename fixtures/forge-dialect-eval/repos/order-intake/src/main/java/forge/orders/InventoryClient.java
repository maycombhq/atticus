package forge.orders;

import forge.messaging.*;

// A relay client: Forge Messaging turns each annotated method into a direct request.
@RelayClient(target = "inventory-api")
public interface InventoryClient {

  @RelayCall(verb = "GET", route = "/stock/{sku}")
  StockLevel stock(String sku);

  @RelayCall(verb = "POST", route = "/reservations")
  Reservation reserve(ReservationRequest request);
}
