package forge.customers;

final class CustomerMapper {
  static Customer toCustomer(CustomerRequest request) {
    Customer c = new Customer();
    c.fullName = request.name;
    c.emailAddress = request.email;
    return c;
  }
}
