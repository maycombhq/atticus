package forge.accounts;

import java.math.BigDecimal;

public record TransferRequest(String fromAccount, String toAccount, BigDecimal amount) {}
