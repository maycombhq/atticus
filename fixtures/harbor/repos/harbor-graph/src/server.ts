import { readFileSync } from "node:fs";
import Fastify from "fastify";
import mercurius from "mercurius";
import { resolvers } from "./resolvers.js";

const app = Fastify({ logger: true });

app.get("/healthz", async () => ({ status: "ok" }));

app.register(mercurius, {
  schema: readFileSync(new URL("../schema/shop.graphql", import.meta.url), "utf8"),
  resolvers,
  path: "/graphql",
  graphiql: false,
});

await app.listen({ port: 4000, host: "0.0.0.0" });
