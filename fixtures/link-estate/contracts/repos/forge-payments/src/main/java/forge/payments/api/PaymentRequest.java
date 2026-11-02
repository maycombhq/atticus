package forge.payments.api;

import jakarta.validation.constraints.NotNull;
import java.math.BigDecimal;

public record PaymentRequest(
    @NotNull String debtorAccount,
    @NotNull BigDecimal amount,
    @NotNull String currency,
    @NotNull String channel) {}
