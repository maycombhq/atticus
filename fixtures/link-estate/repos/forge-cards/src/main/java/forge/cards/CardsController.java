package forge.cards;

import forge.starter.http.ForgeRestClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class CardsController {
  private final ForgeRestClient accounts = ForgeRestClient.forService("accounts");
  private final ForgeRestClient payments = ForgeRestClient.forService("payments");

  @GetMapping("/limits/{id}")
  public LimitView limit(@PathVariable String id) {
    AccountView account = accounts.get("/accounts/{id}", AccountView.class, id);
    return LimitView.of(account);
  }

  @GetMapping("/cards/{id}/ready")
  public boolean ready(@PathVariable String id) {
    return payments.get("/ping", String.class) != null;
  }
}
