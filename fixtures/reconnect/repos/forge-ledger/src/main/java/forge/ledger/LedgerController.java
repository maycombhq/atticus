package forge.ledger;

import org.springframework.web.bind.annotation.*;

@RestController
public class LedgerController {
  @GetMapping("/holds/{id}")
  public String hold() { return "hold"; }
  @PostMapping("/holds/{id}/release")
  public String release() { return "release"; }
  @GetMapping("/fees/{id}")
  public String fee() { return "fee"; }
  @GetMapping("/entries/{id}")
  public String entry() { return "entry"; }
  @PostMapping("/entries")
  public String post() { return "post"; }
  @GetMapping("/statements/{id}")
  public String statement() { return "statement"; }
  @PostMapping("/charges")
  public String charge() { return "charge"; }
}
