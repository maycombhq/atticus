import { normalizePath, type CatalogRecord } from "@maycombhq/core";
import { defineExtractor } from "@maycombhq/sdk";
import { readYamlDocs } from "../platform/manifests.js";
import { isObj } from "../platform/util.js";
import {
  descendants,
  enclosingCalls,
  isString,
  keyOf,
  lineOf,
  stringValue,
  withTree,
} from "../lang/code-tree.js";
import { syntaxLanguageOf } from "../lang/syntax.js";
import { endpoint, loose, own, read, sources } from "./common.js";

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
const CALLBACK_KEYS = new Set([
  "url",
  "callbackUrl",
  "callback_url",
  "webhookUrl",
  "webhook_url",
  "notificationUrl",
  "notification_url",
  "notifyUrl",
  "notify_url",
]);
/** An absolute http(s) URL written whole in one literal. */
const HTTP_URL = /^https?:\/\/\S+$/;
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
      const doc = readYamlDocs(text, { cache: repo.parseCache, path })?.[0];
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
      const lang = syntaxLanguageOf(path);
      if (text === undefined || !lang || !/hook/i.test(text)) continue;
      const found = await withTree(
        lang,
        text,
        (root) => {
          const out: { callback: string; line: number; registrar?: string }[] = [];
          for (const n of descendants(root)) {
            const keyNode =
              n.type === "pair"
                ? n.childForFieldName("key")
                : n.type === "keyword_argument"
                  ? n.childForFieldName("name")
                  : null;
            const key = n.type === "pair" ? keyOf(n) : keyNode?.text;
            const callback = stringValue(n.childForFieldName("value"), true);
            if (
              !keyNode ||
              !key ||
              !CALLBACK_KEYS.has(key) ||
              !callback ||
              !HTTP_URL.test(callback)
            )
              continue;
            // The outermost call the key is written in, within its function.
            const call = enclosingCalls(n).at(-1);
            if (!call) continue;
            const callee = call.path?.join(".") ?? call.name;
            const before = [...descendants(call.node)].filter(
              (x) => x.endIndex <= keyNode.startIndex,
            );
            const said = before
              .filter((x) => x.childCount === 0 || isString(x))
              .map((x) => x.text)
              .join(" ");
            if (!/hook/i.test(`${callee} ${said}`)) continue;
            const url = before
              .filter(isString)
              .map((x) => stringValue(x, true))
              .find((v) => v !== undefined && HTTP_URL.test(v));
            const root0 = callee.split(".")[0]!;
            const registrar =
              url ?? (GENERIC.has(root0.toLowerCase()) ? undefined : root0.toLowerCase());
            out.push({ callback, line: lineOf(keyNode), ...(registrar ? { registrar } : {}) });
          }
          return out;
        },
        { cache: repo.parseCache, path },
      );
      for (const { callback, line, registrar } of found) {
        const cbPath = /^https?:\/\/[^/]+(\/[^?#]*)?/.exec(callback)?.[1] ?? "/";
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
