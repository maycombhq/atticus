package forge.fees;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/fees")
public class FeesController {

  @GetMapping("/retrieve")
  public FeeList retrieve(@RequestParam String account) {
    return FeeList.empty(account);
  }

  @PostMapping("/quote")
  public FeeQuote quote(@RequestBody QuoteRequest request) {
    return FeeQuote.of(request);
  }
}
