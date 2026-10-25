package forge.orders.text;

/** Plain words for the notes staff write on an order's events. */
public final class Plain {
  private Plain() {}

  private static final String[][] WORDS = {{"RMA", "return"}, {"OOS", "out of stock"}};

  public static String tidy(String text) {
    String out = text;
    for (String[] w : WORDS) out = out.replace(w[0], w[1]);
    return out.trim();
  }
}
