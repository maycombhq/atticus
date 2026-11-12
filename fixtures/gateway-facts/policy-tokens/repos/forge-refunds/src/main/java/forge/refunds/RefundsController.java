package forge.refunds;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/refunds")
public class RefundsController {
  @PostMapping
  public Refund create(@RequestBody Refund body) { return body; }

  @GetMapping("/{id}")
  public Refund get(@PathVariable String id) { return Refund.of(id); }
}
