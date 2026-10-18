package forge.billing;

import forge.messaging.*;

public class BillingFlows {

  @OnMessage(group = "billing", channel = "invoices.issued")
  public void onInvoice(Object invoice) { }

  @Emits(channel = "billing.closed")
  public Object closed(Object period) { return period; }

  @QueueConsumer(queue = "BILLING.IN", concurrency = 2)
  public void inbound(Object message) { }
}
