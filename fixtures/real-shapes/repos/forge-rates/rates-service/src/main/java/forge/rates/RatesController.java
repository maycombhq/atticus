package forge.rates;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class RatesController {

    @GetMapping(path = "/rates/{currency}", produces = "application/json")
    public Rate rate(@PathVariable String currency) {
        return Rate.of(currency);
    }
}
