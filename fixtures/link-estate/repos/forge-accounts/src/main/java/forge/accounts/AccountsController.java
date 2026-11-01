package forge.accounts;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AccountsController {
  private final NotifyClient notify;
  private final AuditClient audit;

  public AccountsController(NotifyClient notify, AuditClient audit) {
    this.notify = notify;
    this.audit = audit;
  }

  @GetMapping("/accounts/{id}")
  public AccountView get(@PathVariable String id) {
    return AccountView.of(id);
  }

  @GetMapping("/limits/{id}")
  public LimitView limit(@PathVariable String id) {
    return LimitView.of(id);
  }

  @PostMapping("/accounts/{id}/debits")
  public DebitView debit(@PathVariable String id, @RequestBody DebitRequest req) {
    DebitView done = DebitView.of(id, req);
    notify.debited(done);
    audit.record(done);
    return done;
  }
}
