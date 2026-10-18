package forge.ledger;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.util.UUID;

@Entity
@Table(name = "entry")
public class Entry {
    @Id
    @Column(name = "entry_id")
    private UUID id;

    @ManyToOne(optional = false)
    @JoinColumn(name = "account_id")
    private Account account;

    @Column(columnDefinition = "NUMERIC(19,2)")
    private BigDecimal amount;

    private String postingReference;
}
