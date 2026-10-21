package forge.customers;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/customers")
public class CustomerController {
  private final CustomerRepository repo;

  @PostMapping
  public CustomerView create(@RequestBody CustomerRequest request) {
    Customer saved = repo.insert(CustomerMapper.toCustomer(request));
    return CustomerView.of(saved);
  }

  @GetMapping("/{customerId}")
  public CustomerView get(@PathVariable String customerId) {
    return CustomerView.of(repo.findById(customerId));
  }

  @DeleteMapping("/{customerId}")
  public void remove(@PathVariable String customerId) {
    repo.delete(customerId);
  }
}
