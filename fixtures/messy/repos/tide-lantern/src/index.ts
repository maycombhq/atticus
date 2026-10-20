import { useEffect, useState } from "react";
import { lantern } from "./client";
import type { ApiRequest } from "./request";

export { lantern, LanternClient } from "./client";
export { Services } from "./request";
export type { ApiRequest, HttpMethod } from "./request";

/** The SPA's data hook: one request, re-run when it changes. */
export function useApi<T>(req: ApiRequest): { data?: T; error?: Error } {
  const [state, setState] = useState<{ data?: T; error?: Error }>({});
  useEffect(() => {
    lantern.call<T>(req.service, req.method, req.path, req.body).then(
      (data) => setState({ data }),
      (error: Error) => setState({ error }),
    );
  }, [req.service, req.method, req.path]);
  return state;
}

/** A formatting helper, not a call. */
export function formatAmount(amount: number, currency: string): string {
  return `${amount} ${currency}`;
}
