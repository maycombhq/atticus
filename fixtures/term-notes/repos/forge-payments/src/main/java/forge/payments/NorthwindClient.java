package forge.payments;

public class NorthwindClient {
  private final HttpClient http = HttpClient.newBuilder().sslContext(mtlsContext).build();

  public String charge(String body) {
    return http.post("https://api.northwindpay.example/v1/charges", body)
        .header("Authorization", "Bearer " + tokens.clientCredentials());
  }

  private final SSLContext mtlsContext = SslContexts.fromKeyStore("northwind-client.p12");
}
