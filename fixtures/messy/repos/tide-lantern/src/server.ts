import type { HttpMethod } from "./request";

export { lantern } from "./client";

export type Handler = (req: unknown) => unknown;

const table: { method: HttpMethod; path: string; handler: Handler }[] = [];

/** Register a BFF route. */
export function defineRoute({ method, path, handler }: { method: HttpMethod; path: string; handler: Handler }): void {
  table.push({ method, path, handler });
}

export class Router {
  /** Register a BFF route, positionally. */
  route(method: HttpMethod, path: string, handler: Handler): void {
    defineRoute({ method, path, handler });
  }
}

export const router = new Router();
