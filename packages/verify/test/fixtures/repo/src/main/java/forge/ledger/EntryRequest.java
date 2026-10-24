package forge.ledger;

import jakarta.validation.constraints.NotNull;
import java.math.BigDecimal;

public class EntryRequest {
  //
  @NotNull private BigDecimal amount;
  private String currency;

  public BigDecimal getAmount() { return amount; }
  public String getCurrency() { return currency; }
}
