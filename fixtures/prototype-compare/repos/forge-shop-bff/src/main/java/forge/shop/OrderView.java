package forge.shop;

import java.math.BigDecimal;

public record OrderView(String orderId, String status, BigDecimal total) {
  static OrderView of(String orderId) {
    return new OrderView(orderId, "open", BigDecimal.ZERO);
  }
}
