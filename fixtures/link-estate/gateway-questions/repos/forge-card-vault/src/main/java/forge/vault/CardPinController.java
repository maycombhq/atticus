package forge.vault;

import org.springframework.web.bind.annotation.*;

@RestController
public class CardPinController {
  @GetMapping("/cards/{id}/pin")
  public String pin(@PathVariable String id) { return null; }

  @PutMapping("/cards/{id}/pin")
  public String setPin(@PathVariable String id, @RequestBody String pin) { return pin; }
}
