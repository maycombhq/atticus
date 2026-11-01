package forge.wallet.support;

public final class Ids {
  public static String next() {
    return java.util.UUID.randomUUID().toString();
  }
}
