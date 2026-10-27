export interface CheckoutRequest {
  invoiceId: string;
  currency: string;
}

export interface Receipt {
  receiptId: string;
  status: string;
  loyaltyPoints: number;
}

export interface Order {
  orderId: string;
  status: string;
  total: number;
}
