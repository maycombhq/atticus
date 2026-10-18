package forge.portal;

import org.springframework.web.client.RestTemplate;

public class AuditPublisher {
  private final RestTemplate rest = new RestTemplate();

  public void record(Object event) {
    // Direct call to the audit service; not on the architecture diagram.
    rest.postForObject("${audit.url}/audit/events", event, Void.class);
  }
}
