package forge.limits;

import jakarta.validation.constraints.*;
import java.math.BigDecimal;

public class LimitRequest {
  @NotNull
  @DecimalMax("50000.00")
  private BigDecimal amount;

  @Pattern(regexp = "[A-Z]{3}")
  private String currency;

  public BigDecimal getAmount() { return amount; }
  public String getCurrency() { return currency; }
}
