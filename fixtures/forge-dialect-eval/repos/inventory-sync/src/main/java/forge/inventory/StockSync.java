package forge.inventory;

import forge.messaging.*;

public class StockSync {

  @OnMessage(channel = "orders.received", group = "inventory-sync")
  public void reserveFor(Object order) { }

  @Emits(channel = "stock.changed")
  public StockChanged changed(Object level) { return null; }

  @QueueConsumer(queue = "STOCK.ADJUST")
  public void adjust(Object adjustment) { }
}
