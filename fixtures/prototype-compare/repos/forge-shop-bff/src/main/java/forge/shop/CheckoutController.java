package forge.shop;

import forge.security.RequiresScope;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.client.RestClient;

@RestController
public class CheckoutController {
  private final RestClient billing;

  public CheckoutController(RestClient billing) {
    this.billing = billing;
  }

  @RequiresScope("shop.checkout")
  @PostMapping("/checkout")
  public Receipt checkout(@RequestBody Basket basket) {
    return billing.post().uri("/invoices/{id}/pay", basket.invoiceId()).body(basket).retrieve().body(Receipt.class);
  }
}
