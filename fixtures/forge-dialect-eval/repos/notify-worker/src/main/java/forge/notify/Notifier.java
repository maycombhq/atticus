package forge.notify;

import forge.messaging.*;

public class Notifier {

  @OnMessage(channel = "stock.changed", group = "notify")
  public void onStock(Object change) { }

  @OnMessage(channel = "orders.received", group = "notify")
  public void onOrder(Object order) { }

  @Emits(channel = "notifications.sent")
  public Object sent(Object notification) { return notification; }

  @QueueConsumer(queue = "NOTIFY.RETRY", concurrency = 1)
  public void retry(Object failed) { }

  private String template(String name) { return name; }
}
