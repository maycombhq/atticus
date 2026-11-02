package forge.portal.api;

import java.math.BigDecimal;

public record PaymentRequest(String accountId, BigDecimal amount, String currency, String memo) {}
