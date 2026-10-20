/** What every Lantern call says: which service, which method, which path. */
export interface ApiRequest {
  service: string;
  method: HttpMethod;
  path: string;
  body?: unknown;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

/** Service ids the platform team registers; their base URLs live in the service registry. */
export const Services = {
  BFF: "web-bff",
  CARDS: "cards",
} as const;
