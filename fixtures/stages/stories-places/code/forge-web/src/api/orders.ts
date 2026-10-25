import { http } from "./http";

export interface Order {
  id: string;
  status: string;
}

export interface Citation {
  event: string;
  text: string;
}

export async function getOrder(orderId: string): Promise<Order> {
  return http.get<Order>(`/orders/${orderId}`);
}
