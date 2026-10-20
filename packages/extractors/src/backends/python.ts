import { defineExtractor } from "@maycombhq/sdk";
import {
  cleanDbUrl,
  componentGap,
  dirOf,
  dotenv,
  Emitter,
  Evaluator,
  joinPath,
  joinUrl,
  listSources,
  RouteGraph,
  SourceFile,
  unresolved,
  type SrcCall,
} from "./shared.js";

const VERBS: Record<string, string> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  delete: "DELETE",
  patch: "PATCH",
  head: "HEAD",
  options: "OPTIONS",
};
const ROUTER_CTORS: Record<string, "fastapi" | "flask"> = {
  FastAPI: "fastapi",
  APIRouter: "fastapi",
  Flask: "flask",
  Blueprint: "flask",
};
const CLIENT_CTORS = new Set([
  "requests.Session",
  "requests.session",
  "Session",
  "httpx.Client",
  "httpx.AsyncClient",
  "AsyncClient",
  "aiohttp.ClientSession",
  "ClientSession",
]);
const ENV_CALLS = new Set([
  "os.environ.get",
  "os.getenv",
  "environ.get",
  "getenv",
  "os.environ.setdefault",
]);

interface PyFile {
  src: SourceFile;
  ev: Evaluator;
  /** Imported names: local name → module path, and for `from m import x`, the attribute. */
  imports: Map<string, { module: string; attr?: string }>;
  routers: Map<string, string>;
}

/** Module path ("fx_rates.rates", or ".rates" relative to the file) → file in the repo. */
function moduleFile(files: Map<string, PyFile>, from: string, module: string): string | undefined {
  let mod = module;
  if (mod.startsWith(".")) {
    const ups = /^\.+/.exec(mod)![0].length;
    let dir = dirOf(from);
    for (let k = 1; k < ups; k++) dir = dirOf(dir);
    mod = `${dir ? `${dir}/` : ""}${mod.slice(ups).replace(/\./g, "/")}`;
  } else mod = mod.replace(/\./g, "/");
  const want = [`${mod}.py`, `${mod}/__init__.py`];
  for (const w of want) if (files.has(w)) return w;
  for (const w of want) for (const p of files.keys()) if (p.endsWith(`/${w}`)) return p;
  return undefined;
}

/** Imported names from the file's import statements: `import a.b` binds a, `from m import x as y` binds y. */
function readImports(src: SourceFile): Map<string, { module: string; attr?: string }> {
  const out = new Map<string, { module: string; attr?: string }>();
  for (const i of src.imports)
    for (const n of i.names)
      out.set(
        n.local,
        n.name === "*"
          ? { module: n.local === i.spec.split(".")[0] ? n.local : i.spec }
          : { module: i.spec, attr: n.name },
      );
  return out;
}

/**
 * Python: FastAPI and Flask routes (routers, blueprints, include_router and
 * register_blueprint across files), Django urls.py (include() prefixes, method ANY),
 * requests/httpx/aiohttp calls with base URLs, Kafka/RabbitMQ/Service Bus topics, and
 * SQLAlchemy engine URLs. Environment values come from `.env` files, else the default
 * written in `os.environ.get("X", "default")`; anything unknown stays visible as `${X}`.
 */
export const pythonExtractor = defineExtractor({
  id: "python",
  version: "0.1.0",
  claims: [
    "**/*.py",
    "**/pyproject.toml",
    "**/setup.py",
    "**/setup.cfg",
    "**/requirements*.txt",
    "**/Pipfile",
  ],
  async *scan(repo, ctx) {
    const em = new Emitter(repo, ctx);
    const comp = await componentGap("python", repo, ctx);
    if (comp) em.record(comp);
    const env = await dotenv(repo);
    const files = new Map<string, PyFile>();
    const paths = (await listSources(repo, ["**/*.py"])).filter(
      (p) => !/(^|\/)migrations\//.test(p),
    );

    // Module-level UPPER_CASE constants, for names imported from other modules.
    const constants = new Map<string, { file: string; at: number }[]>();
    const valueIn = (file: string, name: string, at: number): string | undefined =>
      files.get(file)?.ev.lookup(name, at);

    for (const path of paths) {
      const src = await SourceFile.parse(
        path,
        await repo.readText(path),
        "python",
        repo.parseCache,
      );
      const imports = readImports(src);
      const pf: PyFile = {
        src,
        imports,
        routers: new Map(),
        ev: undefined as unknown as Evaluator,
      };
      pf.ev = new Evaluator(src, {
        index: (recv, key) =>
          recv === "os.environ" || recv === "environ"
            ? (env.get(key)?.value ?? unresolved(key))
            : undefined,
        call: (c, ev) => {
          if (!ENV_CALLS.has(c.callee) && !/^(env|config)$/.test(c.callee)) return undefined;
          const key = ev.file.str(ev.file.arg(c, 0));
          if (!key) return undefined;
          const def = ev.file.arg(c, 1, "default");
          return env.get(key)?.value ?? (def ? ev.arg(def) : undefined) ?? unresolved(key);
        },
        name: (dotted) => {
          const imp = imports.get(dotted);
          if (!imp?.attr) return undefined;
          const target = moduleFile(files, path, imp.module);
          const defs = constants.get(imp.attr)?.filter((d) => !target || d.file === target) ?? [];
          return defs.length === 1
            ? valueIn(defs[0]!.file, imp.attr, Number.MAX_SAFE_INTEGER)
            : undefined;
        },
      });
      files.set(path, pf);
      for (const [name, list] of src.assigns) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
        for (const a of list)
          if (a.top) {
            const l = constants.get(name) ?? [];
            l.push({ file: path, at: a.at });
            constants.set(name, l);
          }
      }
    }

    // ---- routers: FastAPI apps and APIRouters, Flask apps and Blueprints
    const graph = new RouteGraph();
    const flavor = new Map<string, "fastapi" | "flask">();
    for (const [path, pf] of files) {
      for (const c of pf.src.calls) {
        const ctor = ROUTER_CTORS[c.callee.replace(/^(fastapi|flask)\./, "")];
        if (!ctor) continue;
        const name = pf.src.assignedTo(c);
        if (!name) continue;
        const prefixArg = pf.src.arg(c, 99, ctor === "fastapi" ? "prefix" : "url_prefix");
        const node = graph.node(`${path}#${name}`, (prefixArg && pf.ev.arg(prefixArg)) || "");
        flavor.set(node, ctor);
        pf.routers.set(name, node);
      }
    }
    /** The router a reference like `router`, `rates.router` or an imported name points to. */
    const routerRef = (path: string, ref: string): string | undefined => {
      const pf = files.get(path)!;
      if (pf.routers.has(ref)) return pf.routers.get(ref);
      const [head, ...rest] = ref.split(".");
      const imp = pf.imports.get(head!);
      if (!imp) return undefined;
      if (rest.length === 0 && imp.attr) {
        const f = moduleFile(files, path, imp.module);
        return f ? files.get(f)!.routers.get(imp.attr) : undefined;
      }
      const mod = imp.attr
        ? `${imp.module}${imp.module.endsWith(".") ? "" : "."}${imp.attr}`
        : imp.module;
      const f = moduleFile(files, path, [mod, ...rest.slice(0, -1)].join("."));
      return f ? files.get(f)!.routers.get(rest[rest.length - 1] ?? "") : undefined;
    };

    const routes: { node: string; method: string; path: string; file: string; line: number }[] = [];
    for (const [path, pf] of files) {
      const { src, ev } = pf;
      for (const c of src.calls) {
        const parent = pf.routers.get(c.recv);
        if (parent && (c.name === "include_router" || c.name === "register_blueprint")) {
          const ref = src.arg(c, 0);
          const child = ref ? routerRef(path, src.dotted(ref.from, ref.to) ?? "") : undefined;
          if (!child) continue;
          const pre = src.arg(c, 99, c.name === "include_router" ? "prefix" : "url_prefix");
          graph.edge(
            child,
            parent,
            (pre && ev.arg(pre)) || "",
            c.name === "register_blueprint" && !!pre,
          );
          continue;
        }
        if (!c.decorator || !parent) continue;
        const p = src.arg(c, 0, "path") ?? src.arg(c, 0, "rule");
        const route = p ? ev.arg(p) : undefined;
        if (route === undefined) continue;
        let methods: string[];
        if (VERBS[c.name]) methods = [VERBS[c.name]!];
        else if (c.name === "route" || c.name === "api_route") {
          const m = src.arg(c, 99, "methods");
          methods = m ? src.strings(m.from, m.to).map((s) => s.v.toUpperCase()) : [];
          if (methods.length === 0) methods = ["GET"];
        } else continue;
        for (const method of methods)
          routes.push({ node: parent, method, path: route, file: path, line: c.line });
      }
    }

    // ---- Django urls.py
    for (const [path, pf] of files) {
      if (!/(^|\/)urls\.py$/.test(path)) continue;
      const here = graph.node(`django:${path}`);
      for (const c of pf.src.calls) {
        if (!["path", "re_path", "url"].includes(c.callee)) continue;
        let pattern = pf.ev.arg(pf.src.arg(c, 0, "route"));
        if (pattern === undefined) continue;
        if (c.callee !== "path")
          pattern = pattern
            .replace(/^\^/, "")
            .replace(/\$$/, "")
            .replace(/\(\?P<(\w+)>[^)]*\)/g, "{$1}");
        const view = pf.src.arg(c, 1, "view");
        const inc = view ? pf.src.callAtStart(view.from) : undefined;
        if (inc && inc.callee.endsWith("include") && inc.close === view!.to - 1) {
          const target = pf.src.strings(inc.open + 1, inc.close)[0]?.v;
          const f = target ? moduleFile(files, path, target) : undefined;
          if (f) graph.edge(`django:${f}`, here, pattern);
          continue;
        }
        routes.push({ node: here, method: "ANY", path: pattern, file: path, line: c.line });
      }
    }
    for (const r of routes)
      for (const prefix of graph.prefixes(r.node))
        em.endpoint(r.method, joinPath(prefix, r.path), r.file, r.line);

    // ---- outgoing calls, events and databases
    for (const [path, pf] of files) {
      const { src, ev } = pf;
      const clients = new Map<string, string | undefined>();
      for (const c of src.calls) {
        if (!CLIENT_CTORS.has(c.callee)) continue;
        const name = src.assignedTo(c);
        if (!name) continue;
        const base = src.arg(c, 99, "base_url");
        clients.set(name, base ? ev.arg(base) : undefined);
      }
      const usesRequests = src.imported("requests") || src.imported("httpx");
      for (const c of src.calls) {
        const req = httpCall(c, src, ev, clients, usesRequests);
        if (req) em.call(req.method, req.url, path, c.line);
      }
      for (const e of events(src, ev))
        em.loose(e.kind, e.topic, path, e.line, e.kind === "event-publish" ? "caller" : "callee");
      for (const c of src.calls) {
        if (!/^(sqlalchemy\.)?create(_async)?_engine$/.test(c.callee)) continue;
        const v = ev.arg(src.arg(c, 0, "url"));
        const url = v ? cleanDbUrl(v) : undefined;
        if (url) em.loose("db-connection", url, path, c.line, "caller");
      }
    }
    const dbEnv = env.get("DATABASE_URL");
    const dbUrl = dbEnv ? cleanDbUrl(dbEnv.value) : undefined;
    if (dbEnv && dbUrl && files.size > 0 && !em.has("db-connection", dbUrl))
      em.loose("db-connection", dbUrl, dbEnv.file, dbEnv.line, "caller", "config");
    yield* em.out;
  },
});

function httpCall(
  c: SrcCall,
  src: SourceFile,
  ev: Evaluator,
  clients: Map<string, string | undefined>,
  usesRequests: boolean,
): { method: string; url: string } | undefined {
  const viaModule = usesRequests && (c.recv === "requests" || c.recv === "httpx");
  const viaClient = clients.has(c.recv);
  if (!viaModule && !viaClient) return undefined;
  const base = viaClient ? clients.get(c.recv) : undefined;
  let method: string | undefined;
  let urlArg;
  if (VERBS[c.name]) {
    method = VERBS[c.name];
    urlArg = src.arg(c, 0, "url");
  } else if (c.name === "request" || c.name === "stream") {
    method = src.str(src.arg(c, 0, "method"))?.toUpperCase();
    urlArg = src.arg(c, 1, "url");
  }
  if (!method || !urlArg) return undefined;
  const url = ev.arg(urlArg);
  return url === undefined ? undefined : { method, url: joinUrl(base, url) };
}

function* events(
  src: SourceFile,
  ev: Evaluator,
): Generator<{ kind: "event-publish" | "event-subscribe"; topic: string; line: number }> {
  const kafka = ["confluent_kafka", "aiokafka", "kafka"].some((m) => src.imported(m));
  const pika = src.imported("pika") || src.mentions("pika");
  const bus = src.imported("azure.servicebus");
  const known = (v: string | undefined) => (v && !/[{}]/.test(v) ? v : undefined);
  const one = (a: ReturnType<SourceFile["arg"]>) =>
    a ? { topic: known(ev.arg(a)), line: src.tok(a.from)!.line } : undefined;
  for (const c of src.calls) {
    if (kafka) {
      if (c.name === "produce" || c.name === "send" || c.name === "send_and_wait") {
        const t = one(src.arg(c, 0, "topic"));
        if (t?.topic) yield { kind: "event-publish", topic: t.topic, line: t.line };
      } else if (c.name === "subscribe") {
        const a = src.arg(c, 0, "topics");
        if (a)
          for (const s of src.strings(a.from, a.to))
            yield { kind: "event-subscribe", topic: s.v, line: s.line };
      } else if (/^(AIO)?KafkaConsumer$/.test(c.name)) {
        for (const a of c.args.filter((x) => !x.name)) {
          const t = one(a);
          if (t?.topic) yield { kind: "event-subscribe", topic: t.topic, line: t.line };
        }
      }
    }
    if (pika) {
      if (c.name === "basic_publish") {
        const ex = one(src.arg(c, 0, "exchange"));
        const rk = one(src.arg(c, 1, "routing_key"));
        const t = ex?.topic ? ex : rk;
        if (t?.topic) yield { kind: "event-publish", topic: t.topic, line: t.line };
      } else if (c.name === "basic_consume") {
        const t = one(src.arg(c, 0, "queue"));
        if (t?.topic) yield { kind: "event-subscribe", topic: t.topic, line: t.line };
      }
    }
    if (bus) {
      const m = /^get_(queue|topic)_sender$|^get_(queue|subscription)_receiver$/.exec(c.name);
      if (m) {
        const t = one(
          src.arg(c, 0, m[1] === "queue" || m[2] === "queue" ? "queue_name" : "topic_name"),
        );
        if (t?.topic)
          yield { kind: m[1] ? "event-publish" : "event-subscribe", topic: t.topic, line: t.line };
      }
    }
  }
}
