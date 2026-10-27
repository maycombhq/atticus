package forge.shop;

import org.springframework.web.bind.annotation.*;
import org.springframework.web.client.RestClient;

@RestController
public class CheckoutController {
  private final RestClient billing;

  public CheckoutController(RestClient billing) {
    this.billing = billing;
  }

  @PostMapping("/checkout")
  public Receipt checkout(@RequestBody Basket basket) {
    return billing.post().uri("/invoices/{id}/pay", basket.invoiceId()).body(basket.payment()).retrieve().body(Receipt.class);
  }
}
