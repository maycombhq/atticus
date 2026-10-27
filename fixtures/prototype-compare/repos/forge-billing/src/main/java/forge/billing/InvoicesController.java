package forge.billing;

import org.springframework.web.bind.annotation.*;

@RestController
public class InvoicesController {
  private final NorthwindClient northwind;

  public InvoicesController(NorthwindClient northwind) {
    this.northwind = northwind;
  }

  @PostMapping("/invoices/{id}/pay")
  public ChargeView pay(@PathVariable String id, @RequestBody PayRequest body) {
    return northwind.charge(new ChargeRequest(body.amount(), body.currency(), id));
  }
}
