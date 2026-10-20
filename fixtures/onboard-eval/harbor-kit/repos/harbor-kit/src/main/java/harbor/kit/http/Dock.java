package harbor.kit.http;

import org.springframework.http.HttpMethod;
import org.springframework.web.client.RestTemplate;

/** Harbor's HTTP client: it finds a system's URL in harbor-systems.properties itself. */
public class Dock {
  private final RestTemplate rest;
  private final SystemDirectory directory;

  public Dock(RestTemplate rest, SystemDirectory directory) {
    this.rest = rest;
    this.directory = directory;
  }

  /** Any call: the system, the HTTP verb and the path. */
  public <T> T send(String service, String verb, String path, Object body) {
    return (T) rest.exchange(directory.url(service) + path, HttpMethod.valueOf(verb), null, Object.class).getBody();
  }

  /** A fire-and-forget notification: always a POST to the system's route. */
  public void relay(String system, String route, Object payload) {
    rest.postForObject(directory.url(system) + route, payload, Void.class);
  }
}
