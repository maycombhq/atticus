package forge.desk.parcels.model.response;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;

public class ShipmentsResponseCargo {
  @JsonProperty("shipments")
  private List<Shipment> shipments;
}
