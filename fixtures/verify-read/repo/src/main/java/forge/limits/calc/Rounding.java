package forge.limits.calc;

import java.math.BigDecimal;
import java.math.RoundingMode;

/** Pure arithmetic: no I/O. */
public final class Rounding {
  private Rounding() {}

  public static BigDecimal toCents(BigDecimal amount) {
    return amount.setScale(2, RoundingMode.HALF_EVEN);
  }
}
