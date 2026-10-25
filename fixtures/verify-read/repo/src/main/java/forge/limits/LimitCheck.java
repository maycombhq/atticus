package forge.limits;

import jakarta.persistence.*;
import java.math.BigDecimal;

@Entity
@Table(name = "limit_check")
public class LimitCheck {
  @Id @GeneratedValue private Long id;
  private BigDecimal amount;
  private String currency;
  private boolean allowed;

  public LimitCheck(BigDecimal amount, String currency, boolean allowed) {
    this.amount = amount;
    this.currency = currency;
    this.allowed = allowed;
  }
}
