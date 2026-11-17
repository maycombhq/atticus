package forge.desk.parcels.model.request;

import com.fasterxml.jackson.annotation.JsonProperty;

public class ShipmentsRequest {
  @JsonProperty("receipt")
  private RequestReceipt receipt;

  @JsonProperty("cargo")
  private ShipmentsRequestCargo cargo;
}
