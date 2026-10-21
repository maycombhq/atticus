package forge.payments;

@Entity
@Table(name = "settlements")
public class Settlement {
  @Id @GeneratedValue Long id;
  @Column(name = "merchant_id") @NotNull Long merchantId;
  @Positive Long amount;
  @Size(min = 3, max = 3) String currency;
}
