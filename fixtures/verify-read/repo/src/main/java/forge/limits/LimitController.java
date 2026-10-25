package forge.limits;

import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/limits")
public class LimitController {
  private final LimitService limits;

  public LimitController(LimitService limits) {
    this.limits = limits;
  }

  // Callers hold a client certificate issued by the Forge CA (mtls).
  @PreAuthorize("hasAuthority('SCOPE_limits.write')")
  @PostMapping("/checks")
  public ResponseEntity<LimitDecision> check(@RequestBody LimitRequest req) {
    LimitDecision d = limits.check(req);
    return ResponseEntity.ok(d);
  }

  @GetMapping("/tiers")
  public ResponseEntity<Object> tiers() {
    return ResponseEntity.ok(limits.tiers());
  }
}
