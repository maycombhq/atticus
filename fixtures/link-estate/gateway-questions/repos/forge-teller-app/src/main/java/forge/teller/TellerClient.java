package forge.teller;

import forge.remote.RemoteConfig;

public class TellerClient {
  private final RemoteConfig config;
  private final Http http;

  public TellerClient(RemoteConfig config, Http http) { this.config = config; this.http = http; }

  public void post(String posting) {
    http.post(config.getUri("financial-posting") + "/postings", posting);
  }

  public void close(String id) {
    http.put(config.getUri("core-gateway") + "/forge/core/v1/accounts/" + id + "/status", "CLOSED");
  }

  public void rename(String id, String name) {
    http.put(config.getUri("core-gateway") + "/forge/core/v1/accounts/" + id, name);
  }

  public String pin(String card) {
    return http.get("https://api.forge.example/forge/core/v1/cards/" + card + "/pin");
  }
}
