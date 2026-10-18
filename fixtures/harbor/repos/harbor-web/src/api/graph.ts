// The web shop talks to one backend: the Shop Graph, served on the same host under /graphql.
const GRAPH_URL = "/graphql";

export interface GraphResult<T> {
  data?: T;
  errors?: { message: string }[];
}

export async function graph<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(GRAPH_URL, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as GraphResult<T>;
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  return body.data as T;
}
