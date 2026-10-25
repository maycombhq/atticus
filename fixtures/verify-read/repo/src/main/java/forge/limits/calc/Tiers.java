package forge.limits.calc;

import java.math.BigDecimal;
import java.util.Map;

/** The Forge limit tiers, as a constant table: no I/O. */
public final class Tiers {
  private static final Map<String, BigDecimal> CAPS =
      Map.of("USD", new BigDecimal("50000.00"), "EUR", new BigDecimal("45000.00"));

  private Tiers() {}

  public static BigDecimal capFor(String currency) {
    return CAPS.getOrDefault(currency, BigDecimal.ZERO);
  }

  public static Map<String, BigDecimal> all() {
    return CAPS;
  }
}
