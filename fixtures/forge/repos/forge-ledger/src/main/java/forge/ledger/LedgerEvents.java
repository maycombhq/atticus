package forge.ledger;

import forge.framework.*;

public class LedgerEvents {
  @ForgeSubscribe(topic = "payments.initiated")
  public void onPaymentInitiated(Object payment) { }

  @ForgePublish(topic = "transfers.completed")
  public Object transferCompleted(Object transfer) { return transfer; }
}
