package forge.orders;

import java.math.BigDecimal;

public record ChargeRequest(String reference, BigDecimal amount) {}
