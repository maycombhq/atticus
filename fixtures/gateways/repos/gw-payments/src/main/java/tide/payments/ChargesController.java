package tide.payments;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/v2/charges")
public class ChargesController {
  @PostMapping("")
  public Object handle() {
    return null;
  }
}
