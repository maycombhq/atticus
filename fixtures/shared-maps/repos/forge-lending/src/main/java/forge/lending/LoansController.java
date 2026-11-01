package forge.lending;

import org.springframework.web.bind.annotation.*;

@RestController
public class LoansController {
  private final RiskClient risk;

  public LoansController(RiskClient risk) {
    this.risk = risk;
  }

  @PostMapping("/loans")
  public LoanView apply(@RequestBody LoanRequest body) {
    return risk.decide(body);
  }
}
