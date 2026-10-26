package forge.orders;

import java.math.BigDecimal;

public record DispatchRequest(String courier, String reference, BigDecimal amount) {}
