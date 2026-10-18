package forge.ledger;

import forge.framework.*;

@ForgeService(name = "ledger-api")
public class LedgerEndpoints {

  @ForgeEndpoint(method = "GET", path = "/accounts/{id}/balance", auth = "oauth2")
  public Balance balance(String id) { return null; }

  @ForgeEndpoint(method = "POST", path = "/transfers", auth = "oauth2")
  public TransferResult transfer(TransferRequest request) { return null; }
}
