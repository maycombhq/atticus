package forge.orders;

import forge.messaging.*;

public class OrderHandlers {

  @QueueConsumer(queue = "ORDERS.IN", concurrency = 4)
  public void onOrder(OrderMessage message) { }

  @OnMessage(channel = "payments.settled", group = "order-intake")
  public void onPaymentSettled(Object payment) { }

  @Emits(channel = "orders.received")
  public OrderReceived accepted(OrderMessage message) { return null; }

  // Auditing was switched off; the old channel is kept here for reference only.
  // @Emits(channel = "orders.audit")
  public void audit(OrderMessage message) { }

  @Deprecated
  public void legacyAccept(OrderMessage message) { }
}
