package forge.refunds;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/refunds")
public class RefundsController {

  @PostMapping
  public Refund submitted(@RequestBody RefundRequest request) {
    return Refund.of(request);
  }

  @PostMapping("/submit")
  public Refund legacy(@RequestBody RefundRequest request) {
    return Refund.of(request);
  }
}
