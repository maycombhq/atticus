package forge.ledger;

import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface AccountRepository extends JpaRepository<Account, Long> {
  //
  //
  //
  //
  @Query("select a from account a where a.id = :id")
  Optional<Account> findById(long id);
}
