package forge.orders;

@RestController
@RequestMapping("/orders")
public class OrderController {
  private final OrderRepository orders;
  private final StockClient stock;

  @PostMapping
  public ResponseEntity<OrderDto> place(@Valid @RequestBody NewOrder body) {
    stock.reserve(body.sku(), body.quantity());
    Order order = new Order(body.sku(), body.quantity());
    Order saved = orders.save(order);
    return ResponseEntity.status(201).body(OrderDto.of(saved));
  }

  @GetMapping("/orders/{orderId}")
  public OrderDto get(@PathVariable long orderId) {
    return orders.findById(orderId).map(OrderDto::of).orElseThrow(NotFound::new);
  }

  @DeleteMapping("/{orderId}")
  public void cancel(@PathVariable long orderId) {
    orders.deleteById(orderId);
  }
}
