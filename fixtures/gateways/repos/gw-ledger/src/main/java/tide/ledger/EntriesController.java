package tide.ledger;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/entries")
public class EntriesController {
  @PostMapping("")
  public Object handle() {
    return null;
  }
}
