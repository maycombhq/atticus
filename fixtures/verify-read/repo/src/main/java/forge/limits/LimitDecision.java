package forge.limits;

import java.math.BigDecimal;

public record LimitDecision(boolean allowed, BigDecimal cap) {}
