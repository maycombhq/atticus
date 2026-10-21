package forge.orders;

@Entity
@Table(name = "orders")
public class Order {
  @Id @GeneratedValue private Long id;
  private String sku;
  private int quantity;

  public Order(String sku, int quantity) {
    this.sku = sku;
    this.quantity = quantity;
  }
}
