package forge.house.model;

import jakarta.validation.constraints.NotNull;

public class Address {
  @NotNull private String street;
  private String postcode;
}
