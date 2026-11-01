package forge.wallet;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/wallets")
public class WalletController {
  // GET /wallets/legacy was removed in 2.0; see "/wallets/old"
  @GetMapping("/{id}")
  public Wallet get(String id) {
    return Wallet.of(id);
  }

  @PostMapping("/{id}/holds")
  public Hold hold(String id) {
    return Hold.of(id);
  }

  /* The admin route lives elsewhere: "/admin/wallets" */
  @PostMapping("/{id}/freeze")
  public Wallet freeze(String id) {
    return Wallet.frozen(id);
  }
}
