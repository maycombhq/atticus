package tide.platform.http;

import org.springframework.http.HttpMethod;
import org.springframework.web.client.RestTemplate;

/** The one HTTP client every Tidewater service uses: it finds the service's URL itself. */
public class BankHttp {
  private final RestTemplate rest;
  private final ServiceRegistry registry;

  public BankHttp(RestTemplate rest, ServiceRegistry registry) {
    this.rest = rest;
    this.registry = registry;
  }

  public <T> T exchange(String service, String method, String path, Object body) {
    return (T) rest.exchange(registry.url(service) + path, HttpMethod.valueOf(method), null, Object.class).getBody();
  }

  public <T> T get(String service, String path, Class<T> type) {
    return rest.getForObject(registry.url(service) + path, type);
  }

  String describe() {
    return "BankHttp";
  }
}
