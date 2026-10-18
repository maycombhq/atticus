import { API_URL } from "../config";

// The app sends GraphQL operations to the Shop Graph over the public API host.
export async function request<T>(query: string, variables: Record<string, unknown>, token?: string): Promise<T> {
  const res = await fetch(`${API_URL}/graphql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors[0]!.message);
  return body.data;
}
