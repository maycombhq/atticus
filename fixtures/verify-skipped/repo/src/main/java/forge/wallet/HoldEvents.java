package forge.wallet;

public final class HoldEvents {
  private final Publisher publisher;

  public void placed(Hold h) {
    publisher.send("forge.wallet.hold-placed", h);
  }

  public void released(Hold h) {
    publisher.send("forge.wallet.hold-released", h);
  }
}
