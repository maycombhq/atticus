package tide.cards

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

@RestController
class LimitsController {
  @GetMapping("/limits/{id}")
  fun limit(id: String): Limit? = null
}
