import { normalizePath, type CatalogRecord } from "@maycombhq/core";
import { defineExtractor } from "@maycombhq/sdk";
import {
  callOf,
  callsIn,
  descendants,
  isString,
  kids,
  lineOf,
  objectProperty,
  stringValue,
  withTree,
  type CodeCall,
  type Node,
} from "../lang/code-tree.js";
import { attr, attrs, findAnnotation, parseJava, type Decl, type JavaFile } from "../lang/java.js";
import { syntaxLanguageOf } from "../lang/syntax.js";
import { endpoint, own, read, sources } from "./common.js";

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

/** A string or a name that says the response is an event stream. */
const mentionsSse = (n: Node) =>
  isString(n)
    ? SSE.test(stringValue(n, true) ?? "")
    : /identifier$/.test(n.type) && SSE.test(n.text);

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
    const javaFiles: { path: string; file: JavaFile }[] = [];
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
      const file = await parseJava(text, path);
      javaFiles.push({ path, file });
      const prefix = file.calls.find(
        (c) => c.method === "setApplicationDestinationPrefixes" && c.args[0] !== undefined,
      );
      if (prefix) appPrefix = prefix.args[0]!;
    }
    for (const { path, file } of javaFiles) {
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
      const lang = syntaxLanguageOf(path);
      if (text === undefined || !lang || !/\bws\b|socket\.io|event-stream/.test(text)) continue;
      await withTree(lang, text, (root) => {
        const strings = new Set<string>();
        for (const n of descendants(root)) {
          const v = stringValue(n);
          if (v !== undefined) strings.add(v);
        }
        const calls = callsIn(root);
        /** The `path` option of an options object among a call's arguments. */
        const pathOption = (c: CodeCall) => {
          for (const a of c.args) {
            const v = stringValue(objectProperty(a, "path"), true);
            if (v !== undefined) return v;
          }
          return undefined;
        };
        if (strings.has("ws"))
          for (const c of calls) {
            const p = c.path?.join(".") ?? "";
            if (!c.isNew || !/^(WebSocketServer|WebSocket\.Server|\w+\.Server)$/.test(p)) continue;
            const v = c.args[0]?.type === "object" ? pathOption(c) : undefined;
            if (v) add("websocket", v, path, lineOf(c.node));
          }
        if (strings.has("socket.io")) {
          for (const c of calls)
            if (c.isNew && c.path?.join(".") === "Server")
              add("websocket", pathOption(c) ?? "/socket.io", path, lineOf(c.node));
          for (const c of calls) {
            const ns = stringValue(c.args[0], true);
            if (c.name === "of" && c.receiver && ns?.startsWith("/"))
              add("websocket", ns, path, c.line);
          }
        }
        // An Express-style GET route whose handler sends an event stream.
        for (const c of calls) {
          const route = stringValue(c.args[0], true);
          if (
            c.name !== "get" ||
            !/^(app|router|server)$/.test(c.receiver?.text ?? "") ||
            !route?.startsWith("/")
          )
            continue;
          const sse = c.args.slice(1).some((a) => [...descendants(a)].some(mentionsSse));
          if (sse) add("sse", route, path, lineOf(c.node), "GET");
        }
      });
    }

    // ---- ASP.NET SignalR
    for (const path of await sources(repo, CS)) {
      const text = await read(repo, ctx, path);
      if (text === undefined || !/MapHub/.test(text)) continue;
      await withTree("c_sharp", text, (root) => {
        for (const c of callsIn(root)) {
          const hub = stringValue(c.args[0]);
          if (c.name === "MapHub" && c.typeArgs.length === 1 && hub)
            add("websocket", hub, path, c.line);
        }
      });
    }

    // ---- Python
    for (const path of await sources(repo, PY)) {
      const text = await read(repo, ctx, path);
      if (text === undefined || !/\.websocket\s*\(/.test(text)) continue;
      await withTree("python", text, (root) => {
        for (const n of descendants(root)) {
          if (n.type !== "decorator") continue;
          const c = kids(n)[0] ? callOf(kids(n)[0]!) : undefined;
          const p = stringValue(c?.args[0]);
          if (c?.name === "websocket" && c.path?.length === 2 && p?.startsWith("/"))
            add("websocket", p, path, lineOf(n));
        }
      });
    }

    yield* out.values();
  },
});
