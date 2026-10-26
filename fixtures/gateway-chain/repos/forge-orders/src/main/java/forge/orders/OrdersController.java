package forge.orders;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/** Served behind the Forge edge gateway, which checks the caller's token and its scopes. */
@RestController
public class OrdersController {
  private final Orders orders;

  public OrdersController(Orders orders) {
    this.orders = orders;
  }

  @GetMapping("/orders/{id}")
  public Order get(@PathVariable String id) {
    return orders.find(id);
  }

  @PostMapping("/dispatch")
  public Dispatch create(@RequestBody DispatchRequest body) {
    return orders.dispatch(body);
  }
}
