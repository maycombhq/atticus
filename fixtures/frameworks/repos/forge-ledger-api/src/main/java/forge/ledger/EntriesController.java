package forge.ledger;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/ledger")
public class EntriesController {

  @GetMapping("/entries")
  public String entries() {
    return "[]";
  }
}
