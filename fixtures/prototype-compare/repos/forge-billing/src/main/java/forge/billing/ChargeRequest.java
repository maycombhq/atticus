package forge.billing;

import java.math.BigDecimal;

public record ChargeRequest(BigDecimal amount, String currency, String reference) {}
