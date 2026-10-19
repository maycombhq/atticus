package tide.cards;

import tide.platform.web.InternalApi;
import tide.platform.web.Op;

/** The house starter's annotation: @InternalApi is meta-annotated with @RestController. */
@InternalApi(basePath = "/statements")
public class StatementsController {

  @Op(verb = "GET", path = "/{id}")
  public Statement statement(String id) {
    return null;
  }
}
