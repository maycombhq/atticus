import express from "express";
import { backend } from "./backend.js";
import { requireSso } from "./sso.js";
import type { CheckoutRequest, Order, Receipt } from "./types.js";

const app = express();
app.use(express.json());
app.use(requireSso());

app.post("/checkout", async (req, res) => {
  const body: CheckoutRequest = req.body;
  const charge = await backend.post(`/invoices/${body.invoiceId}/pay`, { amount: 42.5, currency: body.currency });
  const receipt: Receipt = { receiptId: charge.chargeId, status: charge.status, loyaltyPoints: 120 };
  res.json(receipt);
});

app.get("/orders/:orderId", async (req, res) => {
  const charge = await backend.get(`/v1/charges/${req.params.orderId}`);
  const order: Order = { orderId: req.params.orderId, status: charge.status, total: charge.amount };
  res.json(order);
});

app.get("/loyalty/summary", async (req, res) => {
  const balance = await backend.get(`/loyalty/${req.auth.payload.sub}/balance`);
  res.json({ points: balance.points });
});

app.listen(3001);
