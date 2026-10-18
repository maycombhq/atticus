import { defineExtractor } from "@maycombhq/sdk";
import {
  cleanDbUrl,
  componentGap,
  connectionUrl,
  dirOf,
  dotenv,
  Emitter,
  Evaluator,
  joinPath,
  listSources,
  RouteGraph,
  Scopes,
  SourceFile,
  unresolved,
  type Arg,
  type SrcCall,
} from "./shared.js";

type Kind = "gin" | "echo" | "chi" | "mux" | "gorilla";

const CTORS: Record<string, Kind> = {
  "gin.Default": "gin",
  "gin.New": "gin",
  "echo.New": "echo",
  "chi.NewRouter": "chi",
  "chi.NewMux": "chi",
  "http.NewServeMux": "mux",
  "mux.NewRouter": "gorilla",
};
/** Parameter types that make a function parameter a router. */
const PARAM_TYPES: Record<string, Kind> = {
  "gin.Engine": "gin",
  "gin.RouterGroup": "gin",
  "gin.IRouter": "gin",
  "gin.IRoutes": "gin",
  "echo.Echo": "echo",
  "echo.Group": "echo",
  "chi.Router": "chi",
  "chi.Mux": "chi",
  "http.ServeMux": "mux",
  "mux.Router": "gorilla",
};
const UPPER: Record<string, string> = {
  GET: "GET",
  POST: "POST",
  PUT: "PUT",
  DELETE: "DELETE",
  PATCH: "PATCH",
  HEAD: "HEAD",
  OPTIONS: "OPTIONS",
  Any: "ANY",
};
const TITLE: Record<string, string> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Delete: "DELETE",
  Patch: "PATCH",
  Head: "HEAD",
  Options: "OPTIONS",
};
const CLIENT_VERBS: Record<string, string> = {
  Get: "GET",
  Head: "HEAD",
  Post: "POST",
  PostForm: "POST",
};
const METHOD_CONSTS: Record<string, string> = {
  MethodGet: "GET",
  MethodPost: "POST",
  MethodPut: "PUT",
  MethodDelete: "DELETE",
  MethodPatch: "PATCH",
  MethodHead: "HEAD",
  MethodOptions: "OPTIONS",
};

interface GoFile {
  src: SourceFile;
  ev: Evaluator;
  scopes: Scopes;
}

interface FuncDecl {
  file: string;
  name: string;
  params: { name: string; type: string }[];
  body: [number, number];
}

function funcDecls(path: string, src: SourceFile): FuncDecl[] {
  const out: FuncDecl[] = [];
  const t = src.toks;
  for (let k = 0; k < t.length; k++) {
    if (!src.is(k, "func", "id")) continue;
    let j = k + 1;
    if (src.is(j, "(")) j = src.pairs[j]! + 1; // method receiver
    if (t[j]?.t !== "id" || !src.is(j + 1, "(")) continue;
    const name = t[j]!.v;
    const open = j + 1;
    const close = src.pairs[open]!;
    if (close < 0) continue;
    let b = close + 1;
    while (b < t.length && !src.is(b, "{")) {
      if (src.is(b, "(")) b = src.pairs[b]!;
      b++;
    }
    if (!src.is(b, "{")) continue;
    out.push({ file: path, name, params: goParams(src, open, close), body: [b, src.pairs[b]!] });
  }
  return out;
}

/** `(a, b string, r *gin.RouterGroup)` → names with their (pointer-free) types. */
function goParams(src: SourceFile, open: number, close: number): { name: string; type: string }[] {
  const groups: { from: number; to: number }[] = [];
  let from = open + 1;
  let depth = 0;
  for (let k = open + 1; k <= close; k++) {
    const v = src.tok(k)!;
    if (k === close || (v.t === "p" && v.v === "," && depth === 0)) {
      if (k > from) groups.push({ from, to: k });
      from = k + 1;
    } else if (v.t === "p" && "([{".includes(v.v)) depth++;
    else if (v.t === "p" && ")]}".includes(v.v)) depth--;
  }
  const out: { name: string; type: string }[] = [];
  let pending: string[] = [];
  for (const g of groups) {
    const first = src.tok(g.from)!;
    if (g.to - g.from === 1 && first.t === "id") {
      pending.push(first.v);
      continue;
    }
    const type = src.toks
      .slice(g.from + 1, g.to)
      .filter((x) => x.v !== "*")
      .map((x) => x.v)
      .join("");
    for (const n of [...pending, first.v]) out.push({ name: n, type });
    pending = [];
  }
  return out;
}

/**
 * Go: routes from net/http (Go 1.22 "METHOD /path" patterns), gin and echo (groups),
 * chi (Route, Mount, With) and gorilla/mux (Methods, PathPrefix().Subrouter()), following
 * routers through function parameters and returns; http.Get/Post, http.NewRequest and
 * http.Client calls; kafka-go and sarama topics; sql.Open, pgx and gorm connection URLs.
 * Package-level constants are shared across the files of one directory.
 */
export const goExtractor = defineExtractor({
  id: "go",
  version: "0.1.0",
  claims: ["**/*.go", "**/go.mod"],
  async *scan(repo, ctx) {
    const em = new Emitter(repo, ctx);
    const comp = await componentGap("go", repo, ctx);
    if (comp) em.record(comp);
    const env = await dotenv(repo);
    const files = new Map<string, GoFile>();
    const packageNames = new Map<string, Map<string, string>>(); // dir → name → file

    const paths = await listSources(repo, ["**/*.go"]);
    for (const path of paths) {
      const src = new SourceFile(path, await repo.readText(path), "go");
      const dir = dirOf(path);
      const pkg = packageNames.get(dir) ?? new Map<string, string>();
      packageNames.set(dir, pkg);
      const ev = new Evaluator(src, {
        call: (c, e) => {
          const isEnv =
            c.callee === "os.Getenv" || /^(get|lookup|must)?env(or(default)?)?$/i.test(c.name);
          if (!isEnv) return undefined;
          const key = e.file.str(e.file.arg(c, 0));
          if (!key) return undefined;
          const def = c.callee === "os.Getenv" ? undefined : e.arg(e.file.arg(c, 1));
          return env.get(key)?.value ?? def ?? unresolved(key);
        },
        name: (dotted) => {
          const owner = pkg.get(dotted);
          return owner && owner !== path
            ? files.get(owner)?.ev.lookup(dotted, Number.MAX_SAFE_INTEGER)
            : undefined;
        },
      });
      files.set(path, { src, ev, scopes: new Scopes() });
      for (const [name, list] of src.assigns)
        if (!name.includes(".") && list.some((a) => src.blockOf(a.at)[0] === -1) && !pkg.has(name))
          pkg.set(name, path);
    }

    // ---- pass 1: routers created, function parameters and returns
    const graph = new RouteGraph();
    const kinds = new Map<string, Kind>();
    const node = (id: string, kind: Kind) => {
      kinds.set(id, kind);
      return graph.node(id);
    };
    const funcs = new Map<string, { params: (string | undefined)[] }>();
    const returns = new Map<string, string>();
    const decls: FuncDecl[] = [];
    for (const [path, gf] of files) {
      const { src, scopes } = gf;
      for (const c of src.calls) {
        const kind = CTORS[c.callee];
        const name = kind ? src.assignedTo(c) : undefined;
        if (!kind || !name) continue;
        const [, end] = src.blockOf(c.start);
        scopes.define(
          name,
          node(`${path}#${name}@${c.start}`, kind),
          name.includes(".") ? 0 : c.start,
          end,
        );
      }
      for (const d of funcDecls(path, src)) {
        decls.push(d);
        const params = d.params.map((p) => {
          const kind = PARAM_TYPES[p.type];
          if (!kind) return undefined;
          const id = node(`${path}#fn:${d.name}:${p.name}`, kind);
          scopes.define(p.name, id, d.body[0], d.body[1]);
          return id;
        });
        if (params.some(Boolean)) funcs.set(d.name, { params });
      }
    }
    for (const d of decls) {
      const { src, scopes } = files.get(d.file)!;
      for (let k = d.body[0]; k < d.body[1]; k++) {
        if (!src.is(k, "return", "id") || src.tok(k + 1)?.t !== "id") continue;
        const n = scopes.lookup(src.tok(k + 1)!.v, k);
        if (n) returns.set(d.name, n);
      }
    }

    /** The router an expression evaluates to, creating nodes for inline groups. */
    const routerOf = (path: string, a: Arg | undefined): string | undefined => {
      if (!a) return undefined;
      const { src, scopes } = files.get(path)!;
      if (a.to - a.from === 1 && src.tok(a.from)?.t === "id")
        return scopes.lookup(src.tok(a.from)!.v, a.from);
      let c = src.callAtStart(a.from);
      while (c) {
        const next = src.next(c);
        if (!next || next.close >= a.to) break;
        c = next;
      }
      return c && c.close === a.to - 1 ? routerOfCall(path, c) : undefined;
    };
    const receiver = (path: string, c: SrcCall): string | undefined => {
      if (c.chained) return routerOfCall(path, c.chained);
      return files.get(path)!.scopes.lookup(c.recv, c.start);
    };
    const routerOfCall = (path: string, c: SrcCall): string | undefined => {
      const { src, ev } = files.get(path)!;
      const kind = CTORS[c.callee];
      if (kind) return node(`${path}@${c.open}`, kind);
      if (!c.recv && !c.chained) return returns.get(c.name);
      const parent = receiver(path, c);
      if (!parent) return c.recv.includes(".") ? returns.get(c.name) : undefined;
      if (["With", "Use", "Subrouter"].includes(c.name)) return parent;
      if (c.name === "Group" || c.name === "PathPrefix" || c.name === "Route") {
        const seg = ev.arg(src.arg(c, 0));
        if (seg === undefined && c.name !== "Group") return undefined;
        const id = node(`${path}@${c.open}`, kinds.get(parent)!);
        graph.edge(id, parent, seg ?? "");
        return id;
      }
      return undefined;
    };

    // ---- pass 2: groups, mounts, parameter passing and routes
    const routes: { node: string; method: string; path: string; file: string; line: number }[] = [];
    for (const [path, gf] of files) {
      const { src, ev, scopes } = gf;
      for (const c of src.calls) {
        // Assigned groups: v1 := r.Group("/v1"), s := r.PathPrefix("/api").Subrouter()
        if (["Group", "Route", "PathPrefix", "Subrouter", "With"].includes(c.name)) {
          const name = src.assignedTo(c);
          let tail = c;
          for (let n = src.next(tail); n; n = src.next(tail)) tail = n;
          const id = tail === c ? routerOfCall(path, c) : undefined;
          if (name && id && tail === c) scopes.define(name, id, c.start, src.blockOf(c.start)[1]);
        }
        // Route and Group with a function literal: r.Route("/x", func(r chi.Router) {...})
        if (c.name === "Route" || (c.name === "Group" && c.args.length === 1)) {
          const fn = c.args[c.args.length - 1]!;
          if (src.is(fn.from, "func", "id") && src.is(fn.from + 1, "(")) {
            const parent = receiver(path, c);
            const pname = src.tok(fn.from + 2);
            let body = src.pairs[fn.from + 1]! + 1;
            while (body < fn.to && !src.is(body, "{")) body++;
            if (parent && pname?.t === "id" && src.is(body, "{")) {
              const seg = c.name === "Route" ? (ev.arg(src.arg(c, 0)) ?? "") : "";
              const id = node(`${path}@fn${fn.from}`, kinds.get(parent)!);
              graph.edge(id, parent, seg);
              scopes.define(pname.v, id, body, src.pairs[body]!);
            }
          }
        }
      }
    }
    for (const [path, gf] of files) {
      const { src, ev } = gf;
      for (const c of src.calls) {
        // Router passed to a function: registerAdmin(v1), handlers.Register(r.Group("/x"))
        const f = funcs.get(c.name);
        if (f && (!c.recv || !files.get(path)!.scopes.lookup(c.recv, c.start))) {
          f.params.forEach((p, i) => {
            const arg = c.args[i];
            const from = p && arg ? routerOf(path, arg) : undefined;
            if (p && from) graph.edge(p, from, "");
          });
        }
        if (c.name === "Mount") {
          const parent = receiver(path, c);
          const child = routerOf(path, src.arg(c, 1));
          const seg = ev.arg(src.arg(c, 0));
          if (parent && child && seg !== undefined) graph.edge(child, parent, seg);
          continue;
        }
        // net/http default mux
        if (c.callee === "http.HandleFunc" || c.callee === "http.Handle") {
          const p = ev.arg(src.arg(c, 0));
          if (p !== undefined)
            routes.push({
              node: graph.node("http.DefaultServeMux"),
              ...pattern(p),
              file: path,
              line: c.line,
            });
          continue;
        }
        const recv = receiver(path, c);
        if (!recv) continue;
        const kind = kinds.get(recv)!;
        let method: string | undefined;
        let pathArg: Arg | undefined;
        if ((kind === "gin" || kind === "echo") && UPPER[c.name]) {
          method = UPPER[c.name];
          pathArg = src.arg(c, 0);
        } else if (kind === "chi" && TITLE[c.name]) {
          method = TITLE[c.name];
          pathArg = src.arg(c, 0);
        } else if (
          (kind === "gin" || kind === "chi") &&
          (c.name === "Handle" || c.name === "Method" || c.name === "MethodFunc") &&
          c.args.length >= 3
        ) {
          method = ev.arg(src.arg(c, 0))?.toUpperCase();
          pathArg = src.arg(c, 1);
        } else if (c.name === "HandleFunc" || c.name === "Handle") {
          const p = ev.arg(src.arg(c, 0));
          if (p === undefined) continue;
          if (kind === "mux") {
            routes.push({ node: recv, ...pattern(p), file: path, line: c.line });
            continue;
          }
          const next = src.next(c);
          const methods = next?.name === "Methods" ? next : undefined;
          const list = methods
            ? src.strings(methods.open + 1, methods.close).map((s) => s.v.toUpperCase())
            : [];
          for (const m of list.length ? list : ["ANY"])
            routes.push({ node: recv, method: m, path: p, file: path, line: c.line });
          continue;
        }
        const p = pathArg ? ev.arg(pathArg) : undefined;
        if (method && p !== undefined)
          routes.push({ node: recv, method, path: p, file: path, line: c.line });
      }
    }
    for (const r of routes)
      for (const prefix of graph.prefixes(r.node))
        em.endpoint(r.method, joinPath(prefix, r.path), r.file, r.line);

    // ---- outgoing calls, events and databases
    for (const [path, gf] of files) {
      const { src, ev } = gf;
      const text = src.text;
      const clients = new Set(["http.DefaultClient"]);
      for (const [name, list] of src.assigns) {
        for (const a of list) {
          let k = a.from;
          if (src.is(k, "&")) k++;
          if (src.dotted(k, k + 3) === "http.Client" && src.is(k + 3, "{")) clients.add(name);
        }
      }
      for (const c of src.calls) {
        let method: string | undefined;
        let urlArg: Arg | undefined;
        if (c.recv === "http" && CLIENT_VERBS[c.name]) {
          method = CLIENT_VERBS[c.name];
          urlArg = src.arg(c, 0);
        } else if (clients.has(c.recv) && CLIENT_VERBS[c.name]) {
          method = CLIENT_VERBS[c.name];
          urlArg = src.arg(c, 0);
        } else if (c.callee === "http.NewRequest" || c.callee === "http.NewRequestWithContext") {
          const off = c.name === "NewRequest" ? 0 : 1;
          const m = src.arg(c, off);
          const dotted = m ? src.dotted(m.from, m.to) : undefined;
          method = dotted ? METHOD_CONSTS[dotted.split(".").pop()!] : ev.arg(m)?.toUpperCase();
          urlArg = src.arg(c, off + 1);
        }
        if (!method || !urlArg) continue;
        const url = ev.arg(urlArg);
        if (url !== undefined) em.call(method, url, path, c.line);
      }
      for (const e of events(src, ev, text))
        em.loose(e.kind, e.topic, path, e.line, e.kind === "event-publish" ? "caller" : "callee");
      for (const c of src.calls) {
        let a: Arg | undefined;
        if (/^(sql|sqlx)\.(Open|Connect)$/.test(c.callee)) a = src.arg(c, 1);
        else if (/^(pgxpool\.(New|Connect)|pgx\.Connect)$/.test(c.callee)) a = src.arg(c, 1);
        else if (/^(postgres|mysql|sqlserver)\.Open$/.test(c.callee)) a = src.arg(c, 0);
        const v = a ? ev.arg(a) : undefined;
        const url = v ? (cleanDbUrl(v) ?? connectionUrl(v, "postgres")) : undefined;
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

/** Go 1.22 ServeMux pattern: "[METHOD ][HOST]/path". */
function pattern(p: string): { method: string; path: string } {
  const m = /^(?:([A-Z]+)\s+)?(\S*)$/.exec(p.trim());
  const raw = m?.[2] ?? p;
  return { method: m?.[1] ?? "ANY", path: raw.startsWith("/") ? raw : raw.replace(/^[^/]*/, "") };
}

function* events(
  src: SourceFile,
  ev: Evaluator,
  text: string,
): Generator<{ kind: "event-publish" | "event-subscribe"; topic: string; line: number }> {
  const kafkaGo = /segmentio\/kafka-go/.test(text);
  const sarama = /\bsarama\b/.test(text);
  const confluent = /confluent-kafka-go/.test(text);
  const known = (v: string | undefined) => (v && !/[{}]/.test(v) ? v : undefined);
  const t = src.toks;
  // Composite literals: kafka.Writer{Topic: "x"}, sarama.ProducerMessage{Topic: "x"}
  for (let k = 0; k + 3 < t.length; k++) {
    const type = src.dotted(k, k + 3);
    if (!type || !src.is(k + 3, "{") || (k > 0 && src.is(k - 1, "."))) continue;
    let kind: "event-publish" | "event-subscribe" | undefined;
    if (kafkaGo && (type === "kafka.Writer" || type === "kafka.Message")) kind = "event-publish";
    else if (kafkaGo && type === "kafka.ReaderConfig") kind = "event-subscribe";
    else if (sarama && type === "sarama.ProducerMessage") kind = "event-publish";
    if (!kind) continue;
    const f = src.field(k + 3, "Topic");
    const topic = f ? known(ev.arg(f)) : undefined;
    if (f && topic) yield { kind, topic, line: src.tok(f.from)!.line };
    if (kind === "event-subscribe") {
      const g = src.field(k + 3, "GroupTopics");
      if (g) for (const s of src.strings(g.from, g.to)) yield { kind, topic: s.v, line: s.line };
    }
  }
  for (const c of src.calls) {
    if (sarama && c.name === "ConsumePartition") {
      const a = src.arg(c, 0);
      const topic = known(ev.arg(a));
      if (a && topic) yield { kind: "event-subscribe", topic, line: src.tok(a.from)!.line };
    } else if (
      (sarama && c.name === "Consume" && c.args.length === 3) ||
      (confluent && c.name === "SubscribeTopics")
    ) {
      const a = src.arg(c, c.name === "Consume" ? 1 : 0);
      if (a)
        for (const s of src.strings(a.from, a.to))
          yield { kind: "event-subscribe", topic: s.v, line: s.line };
    } else if (confluent && c.name === "Subscribe") {
      const a = src.arg(c, 0);
      const topic = known(ev.arg(a));
      if (a && topic) yield { kind: "event-subscribe", topic, line: src.tok(a.from)!.line };
    }
  }
}
