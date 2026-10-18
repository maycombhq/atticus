package forge.billing.clients;

import forge.messaging.*;

@RelayClient(target = "ledger-api")
public interface LedgerRelay {

  @RelayCall(route = "/entries", verb = "post")
  Object post(Object entry);
}
