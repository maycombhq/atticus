import { http, HttpResponse } from "msw";

// The backend the prototype expects, mocked: billing and loyalty.
export const handlers = [
  http.post("/invoices/:id/pay", async ({ request }) => {
    const { amount, currency } = (await request.json()) as { amount: number; currency: string };
    return HttpResponse.json({ chargeId: "ch_123", status: "captured" });
  }),

  http.get("/loyalty/:customerId/balance", () => {
    return HttpResponse.json({ points: 1200, tier: "gold" });
  }),
];
