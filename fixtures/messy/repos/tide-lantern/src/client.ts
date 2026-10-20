import type { HttpMethod } from "./request";
import { resolveService } from "./registry";

export class LanternClient {
  /** Call a registered service. */
  async call<T>(service: string, method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const res = await fetch(resolveService(service) + path, { method, body: JSON.stringify(body) });
    return (await res.json()) as T;
  }

  /** Not an HTTP call: clears the client's cache. */
  reset(scope: string): void {
    this._cache.delete(scope);
  }

  private _cache = new Map<string, unknown>();
}

export const lantern = new LanternClient();
