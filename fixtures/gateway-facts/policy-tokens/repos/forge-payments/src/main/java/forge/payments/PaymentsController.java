package forge.payments;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/payments")
public class PaymentsController {
  @GetMapping("/{id}")
  public Payment get(@PathVariable String id) { return Payment.of(id); }

  @PostMapping
  public Payment create(@RequestBody Payment body) { return body; }
}
