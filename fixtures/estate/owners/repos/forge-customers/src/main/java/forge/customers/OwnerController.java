package forge.customers;

import java.util.List;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/owners")
public class OwnerController {
  private final OwnerRepository owners;

  @PostMapping
  public Owner add(@RequestBody OwnerFields fields) {
    Owner owner = new Owner(fields.firstName, fields.lastName);
    owners.save(owner);
    return owner;
  }

  @GetMapping
  public List<Owner> find(@RequestParam String lastName) {
    return owners.findByLastName(lastName);
  }
}
