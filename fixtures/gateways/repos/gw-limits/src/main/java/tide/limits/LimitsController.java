package tide.limits;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/v1/limits")
public class LimitsController {
  @GetMapping("/{id}")
  public Object handle() {
    return null;
  }
}
