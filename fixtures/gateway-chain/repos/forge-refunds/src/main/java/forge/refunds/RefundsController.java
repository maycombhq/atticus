package forge.refunds;

import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/** Served behind the Forge edge gateway's forge-refunds-v1 proxy; its callers are the proxy's. */
@RestController
public class RefundsController {
  private final Refunds refunds;

  public RefundsController(Refunds refunds) {
    this.refunds = refunds;
  }

  @PostMapping("/refunds")
  public Refund create(@Valid @RequestBody RefundRequest body) {
    return refunds.create(body);
  }

  @GetMapping("/refunds/{id}")
  public Refund get(@PathVariable String id) {
    return refunds.find(id);
  }
}
