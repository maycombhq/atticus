package forge.orders;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/** The orders sandbox: the same read, on the host the gateway's dev TargetServer names. */
@RestController
public class OrdersController {
  @GetMapping("/orders/{id}")
  public Order get(@PathVariable String id) {
    return Order.sample(id);
  }
}
