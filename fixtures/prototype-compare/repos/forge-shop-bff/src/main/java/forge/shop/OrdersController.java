package forge.shop;

import forge.security.RequiresScope;
import org.springframework.web.bind.annotation.*;

@RestController
public class OrdersController {
  @RequiresScope("shop.orders.read")
  @GetMapping("/orders/{orderId}")
  public OrderView order(@PathVariable String orderId) {
    return OrderView.of(orderId);
  }
}
