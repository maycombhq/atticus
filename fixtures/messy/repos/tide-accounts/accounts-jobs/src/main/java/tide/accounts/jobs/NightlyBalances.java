package tide.accounts.jobs;

import org.springframework.web.client.RestTemplate;

/** The nightly job reads balances from its sibling app, over HTTP. */
public class NightlyBalances {
  private final RestTemplate restTemplate = new RestTemplate();

  public void run(String id) {
    restTemplate.getForObject("http://accounts-api/accounts/{id}", Account.class, id);
  }
}
