import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";

// The Forge web app's calls to the owners API, straight to the API on its own port.
@Injectable({ providedIn: "root" })
export class OwnerService {
  constructor(private http: HttpClient) {}

  add(owner: { firstName: string; lastName: string }) {
    return this.http.post("http://localhost:9966/owners", owner);
  }

  find(lastName: string) {
    return this.http.get("http://localhost:9966/owners", { params: { lastName } });
  }
}
