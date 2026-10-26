package forge.accounts;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/** Served behind the Forge API gateway, which checks the caller. */
@RestController
public class AccountsController {
  private final Accounts accounts;

  public AccountsController(Accounts accounts) {
    this.accounts = accounts;
  }

  @GetMapping("/accounts/{id}")
  public Account get(@PathVariable String id) {
    return accounts.find(id);
  }

  @PostMapping("/transfers")
  public Transfer create(@RequestBody TransferRequest body) {
    return accounts.transfer(body);
  }
}
