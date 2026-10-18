package harbor.checkout;

import harbor.ledger.v1.LedgerServiceGrpc;

public class LedgerClient {
  private final LedgerServiceGrpc.LedgerServiceBlockingStub stub;

  public LedgerClient(Channel channel) {
    this.stub = LedgerServiceGrpc.newBlockingStub(channel);
  }
}
