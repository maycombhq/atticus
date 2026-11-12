package forge.onboarding;

import org.springframework.web.client.RestClient;

public class InstrumentsClient {
  private final RestClient http;

  public InstrumentsClient(RestClient http) { this.http = http; }

  public Instrument add(NewInstrument body) {
    return http.post().uri("/account_instruments").body(body).retrieve().body(Instrument.class);
  }
}
