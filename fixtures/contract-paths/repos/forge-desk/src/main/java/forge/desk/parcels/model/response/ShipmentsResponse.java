package forge.desk.parcels.model.response;

import com.fasterxml.jackson.annotation.JsonProperty;

public class ShipmentsResponse {
  @JsonProperty("receipt")
  private ResponseReceipt receipt;

  @JsonProperty("cargo")
  private ShipmentsResponseCargo cargo;
}
