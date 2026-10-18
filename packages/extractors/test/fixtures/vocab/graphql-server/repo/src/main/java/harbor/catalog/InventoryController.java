package harbor.catalog;

import org.springframework.graphql.data.method.annotation.*;
import org.springframework.stereotype.Controller;

@Controller
public class InventoryController {

  @QueryMapping
  public Stock stock(@Argument String sku) {
    return null;
  }

  @MutationMapping(name = "reserveStock")
  public Stock reserve(@Argument String sku) {
    return null;
  }

  @SchemaMapping(typeName = "Product", field = "stock")
  public Stock productStock(Product p) {
    return null;
  }
}
