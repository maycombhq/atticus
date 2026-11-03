package forge.gate.client;

import forge.gate.model.LedgerPostRequest;
import forge.gate.model.LedgerPostResponse;
import forge.gate.model.LedgerParty;
import forge.gate.model.LedgerAmount;
import forge.gate.model.LedgerFee;
import forge.gate.model.LedgerError;
import forge.gate.model.TransferRequest;
import forge.gate.model.TransferResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.client.RestTemplate;

public class TidewaterClient {
  private final RestTemplate rest = new RestTemplate();

  @Value("${tidewater.base-url}")
  private String baseUrl;

  public TransferResponse post(TransferRequest transfer) {
    LedgerPostRequest body = new LedgerPostRequest();
    LedgerPostResponse answer =
        rest.postForObject(baseUrl + "/v2/postings", body, LedgerPostResponse.class);
    return new TransferResponse();
  }
}
