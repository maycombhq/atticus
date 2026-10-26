package forge.cards;

import com.forge.platform.web.ForgeEndpoint;
import com.forge.platform.web.ForgeOperation;

/**
 * The house starter turns a @ForgeEndpoint into a REST controller at its `at` path. Nothing in
 * this repo's own code says so, so a reader that doesn't know the starter sees no route here.
 */
@ForgeEndpoint(at = "/cards")
public class CardsEndpoint {

  @ForgeOperation(verb = "GET", at = "/{id}")
  public String card(String id) {
    return "{}";
  }
}
