import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Order, OrderService } from './order.service';

@Component({ selector: 'app-order-add', templateUrl: './order-add.component.html' })
export class OrderAddComponent {
  private orderService = inject(OrderService);
  private router = inject(Router);
  protected readonly order = {} as Order;
  protected readonly errorMessage = signal<string | null>(null);

  onSubmit(order: Order) {
    order.id = null;
    this.orderService.addOrder(order).subscribe({
      next: () => this.router.navigate(['/orders']),
      error: (e) => this.errorMessage.set(String(e)),
    });
  }
}
