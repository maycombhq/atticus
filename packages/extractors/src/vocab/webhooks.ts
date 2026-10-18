import { normalizePath, type CatalogRecord } from "@maycombhq/core";
import { defineExtractor } from "@maycombhq/sdk";
import { readYamlDocs } from "../platform/manifests.js";
import { isObj } from "../platform/util.js";
import { endpoint, lineAt, loose, own, read, sources, stripComments } from "./common.js";

/**
 * Webhooks (ADR 0040).
 *
 * - OpenAPI 3.1 `webhooks:`: each documented webhook operation is a `webhook` Endpoint of the
 *   component whose API documents it, id `<component>.webhook.<name>`, pathOrTopic the
 *   webhook's name and method the operation's. These are callback contracts: whoever
 *   subscribes receives them; merge does not resolve them to a receiver.
 * - Registrations written as literals: a callback URL under a key such as `url`,
 *   `callbackUrl`, `webhook_url` or `notifyUrl`, inside a call whose text mentions a hook
 *   (`fetch("https://.../v1/webhooks", ...)`, `client.webhooks.register({...})`,
 *   `requests.post("https://hooks.../subscriptions", json={...})`). The registering component
 *   receives the callback: a `webhook` Endpoint at the callback's path (method POST, id
 *   `<component>.webhook.<path>`), and a `webhook-callback` loose end
 *   `"POST /path REGISTRAR"` naming who calls back: the first URL in the call, else the root of
 *   the callee when it isn't a generic client name. Merge turns it into an Interface from that
 *   system to this component, via webhook.
 */

const SPECS = ["**/*.yaml", "**/*.yml", "**/*.json"];
const CODE = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.mjs", "**/*.py"];
const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];
const CALLBACK_KEY =
  /["']?\b(url|callbackUrl|callback_url|webhookUrl|webhook_url|notificationUrl|notification_url|notifyUrl|notify_url)\b["']?\s*[:=]\s*["'`](https?:\/\/[^"'`\s]+)["'`]/g;
const GENERIC = new Set([
  "client",
  "api",
  "http",
  "https",
  "axios",
  "requests",
  "httpx",
  "sdk",
  "this",
  "self",
  "fetch",
  "session",
  "await",
]);

/** The outermost call still open at `index`, within a short window before it. */
function openCall(text: string, index: number): { callee: string; start: number } | undefined {
  const from = Math.max(0, index - 500);
  const window = text.slice(from, index);
  let found: { callee: string; start: number } | undefined;
  for (const m of window.matchAll(/([A-Za-z_$][\w$.]*)\s*\(/g)) {
    let depth = 0;
    let closed = false;
    for (let i = from + m.index + m[0].length - 1; i < index && !closed; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") closed = --depth === 0;
    }
    if (!closed) {
      found = { callee: m[1]!, start: from + m.index };
      break; // the first open call is the outermost
    }
  }
  return found;
}

export const webhooksExtractor = defineExtractor({
  id: "webhooks",
  version: "0.1.0",
  claims: [...SPECS, ...CODE],
  async *scan(repo, ctx) {
    const comp = own(repo, ctx);
    const out = new Map<string, CatalogRecord>();
    const add = (e: CatalogRecord) => {
      const cur = out.get(e.id);
      if (cur) cur.evidence.push(...e.evidence);
      else out.set(e.id, e);
    };
    const looseEnds: CatalogRecord[] = [];

    for (const path of await sources(repo, SPECS)) {
      const text = await read(repo, ctx, path);
      if (
        text === undefined ||
        !/openapi["']?\s*:\s*["']?3\.1/.test(text) ||
        !/webhooks/.test(text)
      )
        continue;
      const doc = readYamlDocs(text)?.[0];
      const hooks = isObj(doc?.value) ? doc.value.webhooks : undefined;
      if (!doc || !isObj(hooks)) continue;
      for (const [name, item] of Object.entries(hooks)) {
        if (!isObj(item)) continue;
        for (const method of METHODS) {
          if (!isObj(item[method])) continue;
          add(
            endpoint({
              repo,
              component: comp,
              endpointType: "webhook",
              prefix: "webhook",
              name,
              method: method.toUpperCase(),
              pathOrTopic: name,
              source: "spec",
              path,
              line: doc.line(["webhooks", name, method]),
            }),
          );
        }
      }
    }

    for (const path of await sources(repo, CODE)) {
      const text = await read(repo, ctx, path);
      if (text === undefined || !/hook/i.test(text)) continue;
      const clean = stripComments(text, path.endsWith(".py") ? "hash" : "c");
      for (const m of clean.matchAll(CALLBACK_KEY)) {
        const call = openCall(clean, m.index);
        if (!call) continue;
        const callText = clean.slice(call.start, m.index);
        if (!/hook/i.test(call.callee + callText)) continue;
        const callback = m[2]!;
        const cbPath = /^https?:\/\/[^/]+(\/[^?#]*)?/.exec(callback)?.[1] ?? "/";
        const line = lineAt(clean, m.index);
        add(
          endpoint({
            repo,
            component: comp,
            endpointType: "webhook",
            prefix: "webhook",
            name: cbPath,
            method: "POST",
            pathOrTopic: cbPath,
            normalizedPath: normalizePath(cbPath),
            source: "code",
            path,
            line,
          }),
        );
        const url = /["'`](https?:\/\/[^"'`\s]+)["'`]/.exec(callText)?.[1];
        const root = call.callee.split(".")[0]!;
        const registrar = url ?? (GENERIC.has(root.toLowerCase()) ? undefined : root.toLowerCase());
        if (registrar)
          looseEnds.push(
            loose(repo, comp, "webhook-callback", `POST ${cbPath} ${registrar}`, path, line),
          );
      }
    }
    yield* out.values();
    yield* looseEnds;
  },
});
