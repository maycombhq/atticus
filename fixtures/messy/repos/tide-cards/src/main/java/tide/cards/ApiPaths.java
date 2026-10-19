package tide.cards;

/** House rule: no literal paths in controllers. */
public final class ApiPaths {
  public static final String CARDS = "/cards";
  public static final String BY_ID = "/{id}";

  private ApiPaths() {}
}
