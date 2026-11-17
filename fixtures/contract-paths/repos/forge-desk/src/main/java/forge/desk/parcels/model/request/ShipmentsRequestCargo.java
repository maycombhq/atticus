package forge.desk.parcels.model.request;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;

public class ShipmentsRequestCargo {
  @JsonProperty("shipments")
  private List<ParcelOrder> orders;
}
