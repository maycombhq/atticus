import { Injectable } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import axios from "axios";
import { checkStock } from "./inventory.client";
import { publishOrderPlaced } from "./events";

const PAYMENTS_URL = process.env.PAYMENTS_URL;
const FRAUD_URL = process.env.FRAUD_URL;

const payments = axios.create({ baseURL: PAYMENTS_URL, timeout: 3000 });
const prisma = new PrismaClient();

export interface PlaceOrder {
  customerId: string;
  lines: { sku: string; quantity: number; priceCents: number }[];
}

@Injectable()
export class OrdersService {
  async place(input: PlaceOrder) {
    for (const line of input.lines) {
      const stock = await checkStock(line.sku, line.quantity);
      if (!stock.available) throw new Error(`${line.sku} is out of stock`);
    }
    const totalCents = input.lines.reduce((sum, l) => sum + l.priceCents * l.quantity, 0);
    const risk = await fetch(`${FRAUD_URL}/v1/score`, {
      method: "POST",
      body: JSON.stringify({ customerId: input.customerId, totalCents }),
    });
    if (((await risk.json()) as { score: number }).score > 0.8) throw new Error("Order held for review");
    const order = await prisma.order.create({
      data: { customerId: input.customerId, totalCents, status: "PENDING", lines: { create: input.lines } },
    });
    await payments.post("/payments", { orderId: order.id, amountCents: totalCents });
    await publishOrderPlaced(order.id, input.lines);
    return order;
  }

  find(id: string) {
    return prisma.order.findUnique({ where: { id }, include: { lines: true } });
  }

  abandonedCarts(olderThanMinutes: number) {
    const before = new Date(Date.now() - olderThanMinutes * 60_000);
    return prisma.order.findMany({ where: { status: "CART", updatedAt: { lt: before } } });
  }
}
