package forge.statements;

public class StatementsJob {
  public void run() {
    http.get("https://api.forge.example/forge/accounts");
    http.post("http://files.tidewater.example/v2/statements", batch);
  }
}
