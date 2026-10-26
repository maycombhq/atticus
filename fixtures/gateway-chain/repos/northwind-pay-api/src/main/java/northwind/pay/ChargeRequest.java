package northwind.pay;

import java.math.BigDecimal;

public record ChargeRequest(String reference, BigDecimal amount) {}
