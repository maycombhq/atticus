package forge.rates;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AdminController {

  @PostMapping("/admin/reload")
  public void reload() {}
}
