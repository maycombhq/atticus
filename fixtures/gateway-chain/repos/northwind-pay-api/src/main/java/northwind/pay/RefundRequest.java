package northwind.pay;

import java.math.BigDecimal;

public record RefundRequest(String reference, BigDecimal amount) {}
