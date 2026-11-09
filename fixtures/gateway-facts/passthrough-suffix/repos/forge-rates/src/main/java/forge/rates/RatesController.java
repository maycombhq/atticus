package forge.rates;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/rates")
public class RatesController {

  @GetMapping("/today")
  public RateSheet today() {
    return RateSheet.today();
  }

  @GetMapping("/history/{date}")
  public RateSheet history(@PathVariable String date) {
    return RateSheet.on(date);
  }
}
