import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";

// The Forge web app's calls to the customers API, through the gateway at /api.
@Injectable({ providedIn: "root" })
export class CustomerService {
  constructor(private http: HttpClient) {}

  create(c: { name: string; email: string; phone: string }) {
    return this.http.post("/api/customers", { name: c.name, email: c.email, phone: c.phone });
  }

  get(id: string) {
    return this.http.get(`/api/customers/${id}`);
  }

  remove(id: string) {
    return this.http.delete(`/api/customers/${id}`);
  }

  points(id: string) {
    return this.http.get(`/api/customers/${id}/points`);
  }
}
