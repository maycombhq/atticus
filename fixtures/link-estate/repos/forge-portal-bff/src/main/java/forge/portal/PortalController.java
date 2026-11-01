package forge.portal;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/portal")
public class PortalController {
  private final AccountsClient accounts;
  private final PaymentsClient payments;

  public PortalController(AccountsClient accounts, PaymentsClient payments) {
    this.accounts = accounts;
    this.payments = payments;
  }

  @GetMapping("/accounts/{id}")
  public AccountView account(@PathVariable String id) {
    return accounts.account(id);
  }

  @PostMapping("/payments")
  public PaymentView pay(@RequestBody PaymentRequest req) {
    return payments.pay(req);
  }

  @GetMapping("/payments/{id}")
  public PaymentView payment(@PathVariable String id) {
    return payments.status(id);
  }
}
