package forge.starter.http;

import org.springframework.web.client.RestClient;

/** The house HTTP client every Forge service calls through. */
public final class ForgeRestClient {
  private final RestClient rest;

  private ForgeRestClient(RestClient rest) {
    this.rest = rest;
  }

  public static ForgeRestClient forBase(String baseUrl) {
    return new ForgeRestClient(RestClient.builder().baseUrl(baseUrl).requestInterceptor(TokenInterceptor.get()).build());
  }

  public static ForgeRestClient forService(String serviceId) {
    return forBase(ServiceDirectory.baseUrlOf(serviceId));
  }

  public <T> T get(String path, Class<T> type, Object... vars) {
    return rest.get().uri(path, vars).retrieve().body(type);
  }

  public <T> T post(String path, Object body, Class<T> type, Object... vars) {
    return rest.post().uri(path, vars).body(body).retrieve().body(type);
  }
}
