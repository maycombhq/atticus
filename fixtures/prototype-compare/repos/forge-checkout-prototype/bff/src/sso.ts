import { auth } from "express-oauth2-jwt-bearer";

// Single sign-on: the shop's realm, and the scopes each route asks of the token.
export const ROUTE_SCOPES: Record<string, string[]> = {
  "POST /checkout": ["shop.checkout", "shop.loyalty"],
  "GET /orders/:orderId": ["shop.orders.read"],
  "GET /loyalty/summary": ["shop.loyalty"],
};

export function requireSso() {
  return auth({ issuerBaseURL: "https://sso.forge.example/realms/shop", audience: "forge-shop" });
}
