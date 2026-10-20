import { normalizePath, type CatalogRecord } from "@maycombhq/core";
import { defineExtractor } from "@maycombhq/sdk";
import { attr, attrs, findAnnotation, parseJava, type Decl } from "../lang/java.js";
import { endpoint, lineAt, own, read, sources, stripComments } from "./common.js";

/**
 * WebSocket and server-sent events (ADR 0040): `websocket` and `sse` Endpoints, id
 * `<component>.ws.<path>` or `<component>.sse.<path>`, pathOrTopic the path.
 *
 * - Spring: `@MessageMapping` destinations (with the application destination prefix set in
 *   the same repo), STOMP endpoints (`registry.addEndpoint("/x")`), WebSocket handlers
 *   (`registry.addHandler(h, "/x")`), and SSE where a mapping produces `text/event-stream`
 *   (method GET unless the mapping says otherwise; class-level `@RequestMapping` prefix joined).
 *   The REST endpoint the Spring extractor finds for the same mapping stays.
 * - Node: `ws` servers with a `path` option, socket.io servers (`path` option, else
 *   `/socket.io`) and namespaces (`io.of("/x")`, pathOrTopic the namespace), and Express-style
 *   `get` routes whose handler sets `text/event-stream`.
 * - ASP.NET: SignalR hubs (`MapHub<T>("/x")`).
 * - Python: FastAPI/Starlette `@app.websocket("/x")`.
 */

const JAVA = ["**/*.java", "**/*.kt"];
const NODE = ["**/*.ts", "**/*.js", "**/*.mjs", "**/*.cjs"];
const CS = ["**/*.cs"];
const PY = ["**/*.py"];

const joinPath = (a: string, b: string) =>
  `/${[a, b]
    .map((s) => s.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/")}`;

const SSE = /TEXT_EVENT_STREAM|text\/event-stream/;

/** The text inside the parentheses that open at `open`, nested calls included. */
function argsOf(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}
const MAPPINGS: Record<string, string> = {
  GetMapping: "GET",
  PostMapping: "POST",
  RequestMapping: "GET",
};

export const realtimeExtractor = defineExtractor({
  id: "realtime",
  version: "0.1.0",
  claims: [...JAVA, ...NODE, ...CS, ...PY],
  async *scan(repo, ctx) {
    const comp = own(repo, ctx);
    const out = new Map<string, CatalogRecord>();
    const add = (
      type: "websocket" | "sse",
      path: string,
      file: string,
      line: number,
      method?: string,
    ) => {
      const e = endpoint({
        repo,
        component: comp,
        endpointType: type,
        prefix: type === "websocket" ? "ws" : "sse",
        name: path,
        ...(method ? { method } : {}),
        pathOrTopic: path,
        ...(type === "sse" ? { normalizedPath: normalizePath(path) } : {}),
        source: "code",
        path: file,
        line,
      });
      const cur = out.get(e.id);
      if (cur) cur.evidence.push(...e.evidence);
      else out.set(e.id, e);
    };

    // ---- Spring
    const javaFiles: { path: string; text: string }[] = [];
    let appPrefix = "";
    for (const path of await sources(repo, JAVA)) {
      const text = await read(repo, ctx, path);
      if (
        text === undefined ||
        !/MessageMapping|addEndpoint|addHandler|EVENT_STREAM|event-stream|DestinationPrefixes/.test(
          text,
        )
      )
        continue;
      javaFiles.push({ path, text });
      const prefix = /setApplicationDestinationPrefixes\s*\(\s*"([^"]+)"/.exec(
        stripComments(text, "c"),
      );
      if (prefix) appPrefix = prefix[1]!;
    }
    for (const { path, text } of javaFiles) {
      const file = await parseJava(text, path);
      for (const d of file.decls) {
        if (d.kind !== "method") continue;
        const mm = findAnnotation(d, "MessageMapping");
        if (mm)
          for (const dest of attrs(mm).length ? attrs(mm) : [d.name])
            add("websocket", appPrefix ? joinPath(appPrefix, dest) : dest, path, mm.line);
        for (const [name, method] of Object.entries(MAPPINGS)) {
          const a = findAnnotation(d, name);
          if (!a || !attrs(a, "produces").some((v) => SSE.test(v))) continue;
          const cls = findAnnotation(d.parent as Decl | undefined, "RequestMapping");
          const base = attr(cls) ?? attr(cls, "path") ?? "";
          for (const p of attrs(a).length
            ? attrs(a)
            : attrs(a, "path").length
              ? attrs(a, "path")
              : [""])
            add("sse", joinPath(base, p), path, a.line, method);
        }
      }
      for (const c of file.calls) {
        if (c.method === "addEndpoint")
          for (const p of c.args) if (p?.startsWith("/")) add("websocket", p, path, c.line);
        if (c.method === "addHandler") {
          const p = c.args.filter((x): x is string => !!x && x.startsWith("/"));
          for (const x of p) add("websocket", x, path, c.line);
        }
      }
    }

    // ---- Node
    for (const path of await sources(repo, NODE)) {
      const text = await read(repo, ctx, path);
      if (text === undefined || !/\bws\b|socket\.io|event-stream/.test(text)) continue;
      const clean = stripComments(text, "c");
      if (/["']ws["']/.test(clean))
        for (const m of clean.matchAll(
          /new\s+(?:WebSocketServer|WebSocket\.Server|\w+\.Server)\s*\(\s*\{([^}]*)\}/g,
        )) {
          const p = /\bpath\s*:\s*["'`]([^"'`]+)["'`]/.exec(m[1]!)?.[1];
          if (p) add("websocket", p, path, lineAt(clean, m.index));
        }
      if (/["']socket\.io["']/.test(clean)) {
        for (const m of clean.matchAll(/new\s+Server\s*\(/g)) {
          const p = /\bpath\s*:\s*["'`]([^"'`]+)["'`]/.exec(
            argsOf(clean, m.index + m[0].length - 1),
          )?.[1];
          add("websocket", p ?? "/socket.io", path, lineAt(clean, m.index));
        }
        for (const m of clean.matchAll(/\.of\s*\(\s*["'`](\/[^"'`]*)["'`]/g))
          add("websocket", m[1]!, path, lineAt(clean, m.index));
      }
      if (SSE.test(clean)) {
        const routes = [
          ...clean.matchAll(/\b(?:app|router|server)\.get\s*\(\s*["'`](\/[^"'`]*)["'`]/g),
        ];
        routes.forEach((m, i) => {
          const body = clean.slice(m.index, routes[i + 1]?.index ?? clean.length);
          if (SSE.test(body)) add("sse", m[1]!, path, lineAt(clean, m.index), "GET");
        });
      }
    }

    // ---- ASP.NET SignalR
    for (const path of await sources(repo, CS)) {
      const text = await read(repo, ctx, path);
      if (text === undefined || !/MapHub/.test(text)) continue;
      const clean = stripComments(text, "c");
      for (const m of clean.matchAll(/\bMapHub\s*<\s*\w+\s*>\s*\(\s*"([^"]+)"/g))
        add("websocket", m[1]!, path, lineAt(clean, m.index));
    }

    // ---- Python
    for (const path of await sources(repo, PY)) {
      const text = await read(repo, ctx, path);
      if (text === undefined || !/\.websocket\s*\(/.test(text)) continue;
      const clean = stripComments(text, "hash");
      for (const m of clean.matchAll(/@\w+\.websocket\s*\(\s*["'](\/[^"']*)["']/g))
        add("websocket", m[1]!, path, lineAt(clean, m.index));
    }

    yield* out.values();
  },
});
