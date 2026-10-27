package northwind.pay;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/** Northwind Pay's refund API, reached only through Forge's partner gateway. */
@RestController
public class RefundsController {
  private final Refunds refunds;

  public RefundsController(Refunds refunds) {
    this.refunds = refunds;
  }

  @PostMapping("/v2/refunds")
  public Refund create(@RequestBody RefundRequest body) {
    return refunds.create(body);
  }
}
