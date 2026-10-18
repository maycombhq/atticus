package forge.ledger;

import jakarta.persistence.*;

@Entity
public class TransferRequest {
    @Id
    private Long id;

    @ManyToOne
    @JoinColumn(name = "source_account_id")
    private Account source;

    @ManyToOne
    private Account target;

    @Column(unique = true)
    private String idempotencyKey;
}
