import { describe, expect, it } from "vitest";
import { memoryRepo, scanRepo } from "@maycombhq/sdk";
import { frontendExtractor } from "../src/index.js";

const SHA = "a".repeat(40);

/** A SPA's own thin client, as teams write them: fetch behind two layers of helpers. */
const API = `import { tx } from './i18n/index.js'

const BASE = (import.meta.env?.VITE_API_BASE || '').replace(/\\/$/, '')

const http = async (path, init) => {
  const res = await fetch(BASE + path, init)
  if (!res.ok) throw new Error(tx('failed'))
  return res
}

async function csrfFetch(doFetch) {
  return doFetch()
}

async function post(path, body) {
  const res = await csrfFetch(() => http(\`/api/\${path}\`, { method: 'POST', body: JSON.stringify(body) }))
  return res.json()
}

const getJson = async (path) => (await http(\`/api/\${path}\`, { credentials: 'include' })).json()

export async function put(path, body) {
  return http(\`/api/\${path}\`, { method: 'PUT', body: JSON.stringify(body) })
}

function track(name) {
  console.log(name)
}

export const sendReport = (r) => post('reports', r)
export const listReports = () => getJson('admin/reports')
export const logout = () => http('/api/auth/logout', { method: 'POST' })
export const statement = (id) => getJson(\`statements/\${id}\`)
export const tracked = () => track('x')
`;

describe("a SPA's own HTTP helpers (wrappers defined in the repo)", () => {
  it("reads each call through them as the request it makes, with the prefix they add", async () => {
    const repo = memoryRepo("tide-web", SHA, {
      "src/api.js": API,
      "src/views/Limits.jsx": `import { put } from '../api.js'
export const save = (limits) => put('limits', limits)
`,
      "src/health.js": "export const ping = () => fetch('/health')\n",
    });
    const s = await scanRepo({
      repo,
      extractors: [frontendExtractor],
      repoInfo: { component: "tide-web", repoType: "frontend" },
    });
    const calls = s.records
      .filter((r) => r.kind === "Unresolved")
      .map((r) => {
        const u = r as unknown as { raw: string; evidence: { path: string; line?: number }[] };
        return `${u.raw} @${u.evidence[0]!.path}:${u.evidence[0]!.line}`;
      })
      .sort();
    // Hand-written: one request per call with what it sends; none from inside the helpers.
    expect(calls).toEqual([
      "GET /api/admin/reports @src/api.js:31",
      "GET /api/statements/{id} @src/api.js:33",
      "GET /health @src/health.js:1",
      "POST /api/auth/logout @src/api.js:32",
      "POST /api/reports @src/api.js:30",
      "PUT /api/limits @src/views/Limits.jsx:2",
    ]);
  });
});
