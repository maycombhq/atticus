const CATALOG_URL = process.env.CATALOG_URL;
const ORDERS_URL = process.env.ORDERS_URL;
const RECS_URL = process.env.RECS_URL;

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`upstream answered ${res.status}`);
  return (await res.json()) as T;
}

export const resolvers = {
  Query: {
    products: async (_: unknown, args: { first: number }) =>
      json(await fetch(`${CATALOG_URL}/products?first=${args.first}`)),
    product: async (_: unknown, args: { id: string }) =>
      json(await fetch(`${CATALOG_URL}/products/${args.id}`)),
    order: async (_: unknown, args: { id: string }) =>
      json(await fetch(`${ORDERS_URL}/orders/${args.id}`)),
    recommendations: async (_: unknown, args: { customerId: string; limit: number }) => {
      const res = await fetch(`${RECS_URL}/v1/models/recommendations:predict`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instances: [{ customer_id: args.customerId, k: args.limit }] }),
      });
      const { predictions } = await json<{ predictions: { skus: string[] }[] }>(res);
      return predictions[0]?.skus.map((id) => ({ id })) ?? [];
    },
  },
  Mutation: {
    placeOrder: async (_: unknown, args: { input: unknown }) =>
      json(
        await fetch(`${ORDERS_URL}/orders`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(args.input),
        }),
      ),
  },
};
