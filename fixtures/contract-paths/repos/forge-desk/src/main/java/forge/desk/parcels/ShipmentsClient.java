package forge.desk.parcels;

import forge.desk.parcels.model.request.ShipmentsRequest;
import forge.desk.parcels.model.response.ShipmentsResponse;
import org.springframework.web.client.RestClient;

public class ShipmentsClient {
  private final RestClient parcels;

  public ShipmentsClient(RestClient parcels) {
    this.parcels = parcels;
  }

  public ShipmentsResponse book(ShipmentsRequest request) {
    return parcels.post().uri("https://parcels.forge.example/parcels/v1/shipments")
        .body(request)
        .retrieve()
        .body(ShipmentsResponse.class);
  }
}
