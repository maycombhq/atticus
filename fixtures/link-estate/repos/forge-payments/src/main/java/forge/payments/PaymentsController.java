package forge.payments;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class PaymentsController {
  private final PaymentsService service;

  public PaymentsController(PaymentsService service) {
    this.service = service;
  }

  @PostMapping("/payments")
  public PaymentView pay(@RequestBody PaymentRequest req) {
    return service.pay(req);
  }

  @GetMapping("/ping")
  public String ping() {
    return "ok";
  }
}
