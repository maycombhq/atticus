package forge.accounts;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/accounts")
public class AccountsController {
  private final NorthwindAccountsClient northwind;

  public AccountsController(NorthwindAccountsClient northwind) { this.northwind = northwind; }

  @GetMapping("/{id}")
  public Account get(@PathVariable String id) { return northwind.get(id); }

  @PutMapping("/{id}")
  public Account update(@PathVariable String id, @RequestBody Account body) { return northwind.update(id, body); }

  @PostMapping("/{id}/status")
  public Account status(@PathVariable String id, @RequestBody Status body) { return northwind.status(id, body); }
}
