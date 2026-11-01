package forge.starter.http;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

@Component
public class TokenClient {
  private final RestClient sso;

  public TokenClient(@Value("${forge.starter.sso-url}") String ssoUrl) {
    this.sso = RestClient.builder().baseUrl(ssoUrl).build();
  }

  public TokenView token() {
    return sso.post().uri("/oauth2/token").retrieve().body(TokenView.class);
  }
}
