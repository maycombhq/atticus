package forge.ledger;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/accounts")
public class AccountsController {

    private final RatesClient rates;

    AccountsController(RatesClient rates) {
        this.rates = rates;
    }

    @GetMapping("/{id}")
    public Account account(@PathVariable String id) {
        return new Account(id, rates.rate("EUR"));
    }
}
