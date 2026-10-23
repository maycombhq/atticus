package forge.vault.web;

import forge.platform.web.VaultRoute;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class SecretController {

  @GetMapping("/secrets")
  public String list() {
    return "[]";
  }

  @VaultRoute(path = "/rotate", verb = "POST")
  public String rotate(String id) {
    return id;
  }
}
