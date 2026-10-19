package tide.cards.template;

import org.springframework.web.bind.annotation.GetMapping;

// An archetype left half-edited: the annotation never closes its list.
public class Broken {
  @GetMapping({"/x")
  public void x() {}
}
