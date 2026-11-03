package forge.house.model;

import jakarta.validation.constraints.NotNull;

public class ListingRequest {
  @NotNull private String listingId;
  @NotNull private Address address;
  private Integer bedrooms;
}
