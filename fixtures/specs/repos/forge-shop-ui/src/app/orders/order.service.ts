import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export interface Order {
  id: number | null;
  sku: string;
  quantity: number;
}

@Injectable({ providedIn: 'root' })
export class OrderService {
  private http = inject(HttpClient);
  private entityUrl = '/api/orders';

  addOrder(order: Order): Observable<Order> {
    return this.http
      .post<Order>(this.entityUrl, order);
  }
}
