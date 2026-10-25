package forge.ledger;

import org.springframework.web.bind.annotation.*;

@RestController
public class AccountController {
  private final AccountRepository accounts;

  public AccountController(AccountRepository accounts) {
    this.accounts = accounts;
  }

  // Reads one account by id.
  // The caller must hold the ledger.read scope.
  //
  //
  @PreAuthorize("hasAuthority('SCOPE_ledger.read')")
  @GetMapping("/accounts/{accountId}")
  public Account get(@PathVariable long accountId) {
    return accounts.findById(accountId).orElseThrow();
  }
}
