package forge.limits;

public class InvalidAmount extends RuntimeException {
  public InvalidAmount(String message) {
    super(message);
  }
}
