package forge.shop;

import java.math.BigDecimal;

public record DispatchRequest(String courier, String reference, BigDecimal amount) {}
