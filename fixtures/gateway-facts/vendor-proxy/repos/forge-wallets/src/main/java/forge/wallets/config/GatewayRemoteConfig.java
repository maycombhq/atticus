package forge.wallets.config;

import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "api-gateway-remote-config")
public record GatewayRemoteConfig(String protocol, String host, Map<String, String> uris) {
  public String url(String name) {
    return protocol + "://" + host + uris.get(name);
  }
}
