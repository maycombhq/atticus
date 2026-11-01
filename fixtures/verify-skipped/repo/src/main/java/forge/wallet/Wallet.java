package forge.wallet;

public record Wallet(String id, boolean frozen) {
  static Wallet of(String id) {
    return new Wallet(id, false);
  }

  static Wallet frozen(String id) {
    return new Wallet(id, true);
  }
}
