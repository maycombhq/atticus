package forge.payments;

public class NotifyClient {
  private final HttpClient http;

  public void send(Notice notice) {
    http.post("/notifications", notice);
  }
}
