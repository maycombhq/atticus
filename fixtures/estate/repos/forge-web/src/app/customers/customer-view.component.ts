import { Component, OnInit } from "@angular/core";
import { CustomerService } from "./customer.service";

@Component({ selector: "forge-customer-view", templateUrl: "./customer-view.component.html" })
export class CustomerViewComponent implements OnInit {
  id = "";
  customer?: unknown;
  points?: unknown;

  constructor(private customers: CustomerService) {}

  ngOnInit() {
    this.customers.get(this.id).subscribe((c) => (this.customer = c));
    this.customers.points(this.id).subscribe((p) => (this.points = p));
  }

  remove() {
    this.customers.remove(this.id).subscribe();
  }
}
