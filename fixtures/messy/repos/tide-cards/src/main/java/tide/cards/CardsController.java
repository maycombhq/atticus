package tide.cards;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping(ApiPaths.CARDS)
public class CardsController {

  @GetMapping(ApiPaths.BY_ID)
  public Card card(String id) {
    return null;
  }
}
