package forge.customers;

import jakarta.persistence.*;

@Entity
@Table(name = "owners")
public class Owner {
  @Id @GeneratedValue Long id;

  @Column(name = "first_name")
  String firstName;

  @Column(name = "last_name")
  String lastName;

  Owner(String firstName, String lastName) {
    this.firstName = firstName;
    this.lastName = lastName;
  }
}
