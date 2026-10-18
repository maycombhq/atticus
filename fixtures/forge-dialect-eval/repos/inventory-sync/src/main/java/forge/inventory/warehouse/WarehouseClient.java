package forge.inventory.warehouse;

import forge.messaging.RelayCall;
import forge.messaging.RelayClient;

@RelayClient(target = "warehouse-gateway")
public interface WarehouseClient {

  @RelayCall(verb = "PUT", route = "/bins/:binId")
  void moveBin(String binId, BinMove move);

  @RelayCall(route = "/bins/{binId}/contents", verb = "get")
  BinContents contents(String binId);
}
