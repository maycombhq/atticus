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

  @PostMapping("/invoices/{id}/settle")
  public ChargeView settle(@PathVariable String id, @RequestParam String chargeId) {
    return northwind.capture(chargeId);
  }

  @PostMapping("/invoices/{id}/refund")
  public RefundView refund(@PathVariable String id, @RequestBody RefundRequest body) {
    return northwind.refund(body.chargeId(), body.amount());
  }
}
