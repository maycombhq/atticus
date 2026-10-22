namespace NorthwindPay.Pricing;

model Price {
  id: string;
  currency: string;
  amountMinor: int64;
}

model QuoteRequest {
  priceId: string;
  quantity: int32;
}

model Quote {
  total: int64;
  currency: string;
}

@error
model NotFound {
  code: "not-found";
}
