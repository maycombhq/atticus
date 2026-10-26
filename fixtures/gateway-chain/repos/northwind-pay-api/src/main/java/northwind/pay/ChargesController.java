package northwind.pay;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/** Northwind Pay's charge API, reached only through Forge's partner gateway. */
@RestController
public class ChargesController {
  private final Charges charges;

  public ChargesController(Charges charges) {
    this.charges = charges;
  }

  @PostMapping("/v2/charges")
  public Charge create(@RequestBody ChargeRequest body) {
    return charges.create(body);
  }
}
