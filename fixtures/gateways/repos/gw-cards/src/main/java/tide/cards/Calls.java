package tide.cards;

import org.springframework.web.client.RestTemplate;

/** Every call goes through a gateway; which one depends on who owns the service. */
public class Calls {
  private final RestTemplate rest = new RestTemplate();

  public void charge(Object c) {
    rest.postForObject("https://api-gw.tide.internal/payments/v2/charges", c, Object.class);
  }

  public void post(Object e) {
    rest.postForObject("https://kong.tide.internal/ledger/entries", e, Object.class);
  }

  public Object limit(String id) {
    return rest.getForObject("https://apim.tide.internal/limits/v1/limits/{id}", Object.class, id);
  }
}
