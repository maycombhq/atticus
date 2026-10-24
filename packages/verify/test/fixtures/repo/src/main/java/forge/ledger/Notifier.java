package forge.ledger;

public class Notifier {
  private final HttpClient client;

  public Notifier(HttpClient client) { this.client = client; }

  public void send(String body) {
    client.post("http://notify.internal/notify", body);
  }
}
