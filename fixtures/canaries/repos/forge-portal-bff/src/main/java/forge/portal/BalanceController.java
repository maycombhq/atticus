package forge.portal;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class BalanceController {
  private final LedgerClient ledger;

  public BalanceController(LedgerClient ledger) { this.ledger = ledger; }

  @GetMapping("/balance/{accountId}")
  public Balance balance(@PathVariable String accountId) {
    return ledger.getBalance(accountId);
  }
}
