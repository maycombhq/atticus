package forge.wallets;

import forge.wallets.config.GatewayRemoteConfig;
import org.springframework.web.client.RestClient;

public class NorthwindWalletsClient {
  private final GatewayRemoteConfig gateway;
  private final RestClient http;

  public NorthwindWalletsClient(GatewayRemoteConfig gateway, RestClient http) { this.gateway = gateway; this.http = http; }

  public WalletPage search(String owner) {
    return http.get().uri(gateway.url("searchWallet") + "?owner={o}", owner).retrieve().body(WalletPage.class);
  }

  public Wallet create(NewWallet body) {
    return http.post().uri(gateway.url("createWallet")).body(body).retrieve().body(Wallet.class);
  }

  public Wallet get(String walletGuid) {
    return http.get().uri(gateway.url("getWallet"), walletGuid).retrieve().body(Wallet.class);
  }
}
