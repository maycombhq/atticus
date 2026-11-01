package forge.notifications;

import forge.starter.http.ForgeRestClient;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class NotificationsService {
  private final ForgeRestClient lantern;
  private final ForgeRestClient accounts;

  public NotificationsService(
      @Value("${forge.lantern.base-url}") String lanternBase,
      @Value("${forge.accounts.base-url}") String accountsBase) {
    this.lantern = ForgeRestClient.forBase(lanternBase);
    this.accounts = ForgeRestClient.forBase(accountsBase);
  }

  public void send(NotificationRequest req) {
    AccountView account = accounts.get("/accounts/{id}", AccountView.class, req.accountId());
    lantern.post("/v1/messages", MessageRequest.of(account, req), Void.class);
  }

  public void delivered(DeliveryEvent event) {
    // a delivery receipt from Lantern Mail: nothing to call
  }
}
