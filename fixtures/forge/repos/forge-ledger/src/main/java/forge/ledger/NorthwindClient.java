package forge.ledger;

import forge.framework.*;

// Calls the vendor directly. The architecture diagram says this goes through the gateway.
@ForgeClient(service = "northwind-pay", baseUrl = "${northwind.url}")
public interface NorthwindClient {
  @ForgeCall(method = "POST", path = "/v2/payments")
  PaymentResult pay(PaymentRequest request);
}
