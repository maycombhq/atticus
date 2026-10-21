import { Component } from "@angular/core";
import { CustomerService } from "./customer.service";

@Component({ selector: "forge-customer-form", templateUrl: "./customer-form.component.html" })
export class CustomerFormComponent {
  form = { name: "", email: "", phone: "" };
  saved?: { id: string };

  constructor(private customers: CustomerService) {}

  save() {
    this.customers.create(this.form).subscribe((c) => (this.saved = c as { id: string }));
  }
}
