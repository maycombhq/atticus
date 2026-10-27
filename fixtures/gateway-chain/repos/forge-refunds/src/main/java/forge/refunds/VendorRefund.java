package forge.refunds;

import java.math.BigDecimal;

public record VendorRefund(String reference, BigDecimal amount) {}
