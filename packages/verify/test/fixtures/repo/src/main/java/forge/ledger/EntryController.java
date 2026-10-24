package forge.ledger;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
public class EntryController {
  private final EntryRepository entries;
  private final FxClient fx;

  public EntryController(EntryRepository entries, FxClient fx) {
    this.entries = entries;
    this.fx = fx;
  }

  //
  //
  //
  //
  //
  //
  @PostMapping("/accounts/{accountId}/entries")
  public ResponseEntity<Long> post(@PathVariable long accountId, @RequestBody EntryRequest req) {
    Rate rate;
    try {
      rate = fx.rate(req.getCurrency());
    } catch (FxUnavailable e) { return ResponseEntity.status(503).build(); }
    Entry saved = entries.save(new Entry(accountId, req.getAmount().multiply(rate.value())));
    //
    return ResponseEntity.status(201).body(saved.getId());
  }
}
