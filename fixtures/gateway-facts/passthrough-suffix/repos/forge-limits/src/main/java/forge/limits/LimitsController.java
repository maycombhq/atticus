package forge.limits;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/limits")
public class LimitsController {

  @GetMapping("/check")
  public LimitCheck check(@RequestParam String account) {
    return LimitCheck.of(account);
  }
}
