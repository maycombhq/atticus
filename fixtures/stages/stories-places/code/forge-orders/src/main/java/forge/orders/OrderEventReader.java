package forge.orders;

import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Reads an order's events, oldest first. */
@Component
public class OrderEventReader {
  private final JdbcTemplate jdbc;

  public OrderEventReader(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  static final String BY_ORDER = "select order_id, kind, at from order_events where order_id = ? order by at";

  public List<OrderEvent> forOrder(long orderId) {
    // oldest first, as the order page lists them
    return jdbc.query(BY_ORDER, OrderEvent.MAPPER, orderId);
  }
}
