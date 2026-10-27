// In the prototype every backend call goes to the mock server (mocks/).
const BASE = process.env.MOCK_API ?? "http://localhost:9090";

async function send(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}

export const backend = {
  get: (path: string) => send("GET", path),
  post: (path: string, body: unknown) => send("POST", path, body),
};
