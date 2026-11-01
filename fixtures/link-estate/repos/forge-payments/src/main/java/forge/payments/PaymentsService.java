package forge.payments;

import forge.starter.http.ForgeRestClient;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class PaymentsService {
  private final ForgeRestClient accounts;
  private final ForgeRestClient notify;
  private final ForgeRestClient gateway;
  private final ForgeRestClient limits = ForgeRestClient.forService("limits");

  public PaymentsService(
      @Value("${forge.accounts.base-url}") String accountsBase,
      @Value("${forge.notify.base-url}") String notifyBase,
      @Value("${forge.gateway.base-url}") String gatewayBase) {
    this.accounts = ForgeRestClient.forBase(accountsBase);
    this.notify = ForgeRestClient.forBase(notifyBase);
    this.gateway = ForgeRestClient.forBase(gatewayBase);
  }

  public PaymentView pay(PaymentRequest req) {
    LimitView limit = limits.get("/limits/{id}", LimitView.class, req.accountId());
    accounts.post("/accounts/{id}/debits", DebitRequest.of(req, limit), DebitView.class, req.accountId());
    gateway.post("/forge/northwind/v1/charges", ChargeRequest.of(req), ChargeView.class);
    notify.post("/notifications", NotificationRequest.paid(req), Void.class);
    return PaymentView.done(req);
  }
}
