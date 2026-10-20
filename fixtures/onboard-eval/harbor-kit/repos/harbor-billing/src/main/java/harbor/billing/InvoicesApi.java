package harbor.billing;

import harbor.kit.http.Dock;
import harbor.kit.http.Systems;
import harbor.kit.web.Fetch;
import harbor.kit.web.HarborApi;

@HarborApi(root = "/invoices")
public class InvoicesApi {
  private final Dock dock;

  public InvoicesApi(Dock dock) {
    this.dock = dock;
  }

  @Fetch("/{number}")
  public Invoice invoice(String number) {
    return null;
  }

  void issue(Invoice i) {
    dock.relay(Systems.LEDGER, "/ledger/invoices", i);
  }
}
