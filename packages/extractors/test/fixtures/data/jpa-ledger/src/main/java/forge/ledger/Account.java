package forge.ledger;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.util.List;

@Entity
@Table(name = "account", indexes = {
    @Index(name = "ix_account_owner", columnList = "owner_name")
})
public class Account extends BaseEntity {
    private static final long serialVersionUID = 1L;

    @Column(name = "owner_name", nullable = false, length = 80)
    private String ownerName;

    private BigDecimal balance;

    private boolean frozen;

    @Transient
    private String display;

    @OneToMany(mappedBy = "account")
    private List<Entry> entries;

    public BigDecimal getBalance() {
        return balance;
    }
}
