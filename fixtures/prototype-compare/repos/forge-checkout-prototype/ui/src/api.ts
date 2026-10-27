// The prototype's screens call its BFF on the same origin.
export async function placeOrder(invoiceId: string, currency: string) {
  const res = await fetch("/checkout", { method: "POST", body: JSON.stringify({ invoiceId, currency }) });
  return res.json();
}

export async function getOrder(id: string) {
  const res = await fetch(`/orders/${id}`);
  return res.json();
}

export async function getLoyalty() {
  const res = await fetch("/loyalty/summary");
  return res.json();
}
