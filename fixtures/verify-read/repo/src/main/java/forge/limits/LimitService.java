package forge.limits;

import forge.limits.calc.Rounding;
import forge.limits.calc.Tiers;
import java.math.BigDecimal;

public class LimitService {
  private final LimitRepository repo;

  public LimitService(LimitRepository repo) {
    this.repo = repo;
  }

  public LimitDecision check(LimitRequest req) {
    if (req.getAmount().signum() <= 0) throw new InvalidAmount("amount must be positive");
    BigDecimal rounded = Rounding.toCents(req.getAmount());
    BigDecimal cap = Tiers.capFor(req.getCurrency());
    LimitDecision d = new LimitDecision(rounded.compareTo(cap) <= 0, cap);
    repo.save(new LimitCheck(rounded, req.getCurrency(), d.allowed()));
    return d;
  }

  public Object tiers() {
    return Tiers.all();
  }
}
