package forge.lending;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.client.RestClient;

public class RiskClient {
  private final RestClient http;

  public RiskClient(RestClient.Builder builder, @Value("${forge.risk.base-url}") String base) {
    this.http = builder.baseUrl(base).build();
  }

  public LoanView decide(LoanRequest body) {
    Score score = http.post().uri("/risk/v1/scores").body(body).retrieve().body(Score.class);
    Limit limit = http.get().uri("/v1/limits/{customerId}", body.customerId()).retrieve().body(Limit.class);
    http.post().uri("/risk/v1/fraud-checks").body(body).retrieve().toBodilessEntity();
    return new LoanView(score.value(), limit.amount());
  }
}
