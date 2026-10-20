package tide.accounts.api;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import tide.accounts.common.AccountPaths;

@RestController
@RequestMapping(AccountPaths.ACCOUNTS)
public class AccountsController {
  @GetMapping("/{id}")
  public Account account(String id) {
    return null;
  }
}
