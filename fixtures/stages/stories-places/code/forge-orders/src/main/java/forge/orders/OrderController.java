package forge.orders;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/orders")
public class OrderController {
  private final OrderRepository orders;
  private final OrderEventReader events;

  public OrderController(OrderRepository orders, OrderEventReader events) {
    this.orders = orders;
    this.events = events;
  }

  @GetMapping("/{orderId}")
  public OrderView get(@PathVariable long orderId) {
    return orders.findById(orderId).map(OrderView::of).orElseThrow(NotFound::new);
  }

  @GetMapping("/{orderId}/events")
  public java.util.List<EventView> events(@PathVariable long orderId) {
    var found = events.forOrder(orderId);
    return found.stream().map(EventView::of).toList();
  }
}
