package forge.ledger;

import org.springframework.web.bind.annotation.*;

@RestController
public class AccountsController {
  @GetMapping("/accounts/{id}")
  public AccountView get(@PathVariable String id) { return null; }

  @PutMapping("/accounts/{id}")
  public AccountView update(@PathVariable String id, @RequestBody AccountView body) { return body; }

  @PutMapping("/accounts/{id}/status")
  public AccountView status(@PathVariable String id, @RequestBody String status) { return null; }

  @PostMapping("/postings")
  public String post(@RequestBody String posting) { return posting; }
}
