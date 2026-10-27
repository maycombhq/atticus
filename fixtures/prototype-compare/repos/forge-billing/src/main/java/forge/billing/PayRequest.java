package forge.billing;

import java.math.BigDecimal;

public record PayRequest(BigDecimal amount, String currency) {}
