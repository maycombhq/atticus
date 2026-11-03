package forge.house.api;

import forge.house.client.ValuationClient;
import forge.house.model.ListingRequest;
import forge.house.model.ValuationResponse;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/houses")
public class HouseController {
  private final ValuationClient valuations;

  public HouseController(ValuationClient valuations) {
    this.valuations = valuations;
  }

  @PostMapping("/listings")
  public ValuationResponse list(@RequestBody ListingRequest listing) {
    return valuations.quote(listing);
  }
}
