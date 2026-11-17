package forge.desk.parcels.model.response;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;
import java.util.UUID;

public class ResponseReceipt {
  @JsonProperty("receipt_no")
  private String receiptNo;

  @JsonProperty("depot_token")
  private UUID depotToken;

  @JsonProperty("stamps")
  private List<Stamp> stamps = null;
}
