package forge.wallet;

class WalletControllerTest {
  void gets() throws Exception {
    mvc.perform(get("/wallets/w-1"));
  }
}
