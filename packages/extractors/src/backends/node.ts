import { defineExtractor } from "@maycombhq/sdk";
import {
  cleanDbUrl,
  componentGap,
  dirOf,
  dotenv,
  Emitter,
  Evaluator,
  frontendCall,
  joinPath,
  joinUrl,
  listSources,
  RouteGraph,
  Scopes,
  serverPackages,
  SourceFile,
  unresolved,
  type Arg,
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
  all: "ANY",
};
const NEST_VERBS: Record<string, string> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Delete: "DELETE",
  Patch: "PATCH",
  Head: "HEAD",
  Options: "OPTIONS",
  All: "ANY",
};
const EXTS = [".ts", ".js", ".mjs", ".cjs", ".mts", ".cts"];

// The frontend extractor (../more.ts) also reads Node files and reports fetch/axios/http
// calls whose first argument is a literal starting with "/" or "http". Those call sites
// are left to it, so each call is reported once; this extractor reports the rest.
const FRONTEND_EXT = /\.(ts|tsx|js|jsx|mjs|vue)$/;

const frontendCovers = (path: string, src: SourceFile, c: SrcCall): boolean =>
  FRONTEND_EXT.test(path) && frontendCall(src, c) !== undefined;

interface NodeFile {
  src: SourceFile;
  ev: Evaluator;
  scopes: Scopes;
  /** Local name → module specifier and the export it names ("default" or a name). */
  bindings: Map<string, { spec: string; name: string }>;
  /** Export name → local name. */
  exports: Map<string, string>;
  funcs: { name: string; param: string; body: [number, number]; exported?: string }[];
}

function readModule(src: SourceFile): Pick<NodeFile, "bindings" | "exports" | "funcs"> {
  const t = src.toks;
  const bindings = new Map<string, { spec: string; name: string }>();
  const exports = new Map<string, string>();
  const funcs: NodeFile["funcs"] = [];
  const isReq = (k: number) =>
    src.is(k, "require", "id") && src.is(k + 1, "(") && t[k + 2]?.t === "str" && src.is(k + 3, ")");
  for (let k = 0; k < t.length; k++) {
    const v = t[k]!;
    // import X, { a, b as c } from "spec" / import * as X from "spec"
    if (src.is(k, "import", "id") && !src.is(k + 1, "(")) {
      let j = k + 1;
      const names: [string, string][] = [];
      for (; j < t.length && !src.is(j, "from", "id") && t[j]!.t !== "str"; j++) {
        if (src.is(j, "*") && src.is(j + 1, "as", "id")) {
          names.push([t[j + 2]!.v, "*"]);
          j += 2;
        } else if (src.is(j, "{")) {
          const close = src.pairs[j]!;
          for (let m = j + 1; m < close; m++) {
            if (t[m]!.t !== "id" || t[m]!.v === "type") continue;
            if (src.is(m + 1, "as", "id")) {
              names.push([t[m + 2]!.v, t[m]!.v]);
              m += 2;
            } else names.push([t[m]!.v, t[m]!.v]);
          }
          j = close;
        } else if (t[j]!.t === "id" && t[j]!.v !== "type") names.push([t[j]!.v, "default"]);
      }
      const spec = src.is(j, "from", "id") ? t[j + 1] : t[j];
      if (spec?.t === "str")
        for (const [local, name] of names) bindings.set(local, { spec: spec.v, name });
      continue;
    }
    // const X = require("spec"), const X = require("spec").name, const { a, b: c } = require("spec")
    if (src.is(k, "=") && isReq(k + 1)) {
      const spec = t[k + 3]!.v;
      const member = src.is(k + 5, ".") && t[k + 6]?.t === "id" ? t[k + 6]!.v : "default";
      if (t[k - 1]?.t === "id") bindings.set(t[k - 1]!.v, { spec, name: member });
      else if (src.is(k - 1, "}")) {
        const open = src.pairs[k - 1]!;
        for (let m = open + 1; m < k - 1; m++) {
          if (t[m]!.t !== "id") continue;
          if (src.is(m + 1, ":") && t[m + 2]?.t === "id") {
            bindings.set(t[m + 2]!.v, { spec, name: t[m]!.v });
            m += 2;
          } else bindings.set(t[m]!.v, { spec, name: t[m]!.v });
        }
      }
    }
    // module.exports = X | { a, b: c }, module.exports.X = Y, exports.X = Y
    const me = src.dotted(k, k + 3) === "module.exports" ? 3 : 0;
    if (me && src.is(k + me, "=") && (k === 0 || !src.is(k - 1, "."))) {
      if (t[k + 4]?.t === "id" && !src.is(k + 5, "(") && !src.is(k + 5, "."))
        exports.set("default", t[k + 4]!.v);
      else if (src.is(k + 4, "{")) {
        const close = src.pairs[k + 4]!;
        for (let m = k + 5; m < close; m++) {
          if (t[m]!.t !== "id" || !(src.is(m - 1, "{") || src.is(m - 1, ","))) continue;
          if (src.is(m + 1, ":") && t[m + 2]?.t === "id") exports.set(t[m]!.v, t[m + 2]!.v);
          else if (src.is(m + 1, ",") || m + 1 === close) exports.set(t[m]!.v, t[m]!.v);
        }
      }
    }
    if (
      src.dotted(k, k + 5)?.startsWith("module.exports.") &&
      src.is(k + 5, "=") &&
      t[k + 6]?.t === "id"
    )
      exports.set(t[k + 4]!.v, t[k + 6]!.v);
    if (
      src.dotted(k, k + 3)?.startsWith("exports.") &&
      !src.is(k - 1, ".") &&
      src.is(k + 3, "=") &&
      t[k + 4]?.t === "id"
    )
      exports.set(t[k + 2]!.v, t[k + 4]!.v);
    // export default X, export const X = ..., export function X, export { a, b as c }
    if (src.is(k, "export", "id")) {
      if (
        src.is(k + 1, "default", "id") &&
        t[k + 2]?.t === "id" &&
        !["function", "async", "class"].includes(t[k + 2]!.v)
      )
        exports.set("default", t[k + 2]!.v);
      else if (
        ["const", "let", "var", "function", "class"].includes(t[k + 1]?.v ?? "") &&
        t[k + 2]?.t === "id"
      )
        exports.set(t[k + 2]!.v, t[k + 2]!.v);
      else if (
        src.is(k + 1, "async", "id") &&
        src.is(k + 2, "function", "id") &&
        t[k + 3]?.t === "id"
      )
        exports.set(t[k + 3]!.v, t[k + 3]!.v);
      else if (src.is(k + 1, "{")) {
        const close = src.pairs[k + 1]!;
        for (let m = k + 2; m < close; m++) {
          if (t[m]!.t !== "id") continue;
          if (src.is(m + 1, "as", "id")) {
            exports.set(t[m + 2]!.v, t[m]!.v);
            m += 2;
          } else exports.set(t[m]!.v, t[m]!.v);
        }
      }
    }
    // Functions whose first parameter may be a router or server (Fastify plugins).
    if (v.t === "id" && v.v === "function") {
      const named = t[k + 1]?.t === "id";
      const open = named ? k + 2 : k + 1;
      if (!src.is(open, "(") || t[open + 1]?.t !== "id") continue;
      let body = src.pairs[open]! + 1;
      while (body < t.length && !src.is(body, "{") && body - open < 40) body++;
      if (!src.is(body, "{")) continue;
      let s = k;
      if (src.is(s - 1, "async", "id")) s--;
      const exported =
        src.is(s - 1, "default", "id") && src.is(s - 2, "export", "id")
          ? "default"
          : src.is(s - 1, "=") && src.dotted(s - 4, s - 1) === "module.exports"
            ? "default"
            : undefined;
      const name = named
        ? t[k + 1]!.v
        : src.is(s - 1, "=") && t[s - 2]?.t === "id"
          ? t[s - 2]!.v
          : "default";
      funcs.push({
        name,
        param: t[open + 1]!.v,
        body: [body, src.pairs[body]!],
        ...(exported ? { exported } : {}),
      });
    }
    if (src.is(k, "=>") && src.is(k + 1, "{")) {
      let open = k - 1;
      let param: string | undefined;
      if (src.is(open, ")")) {
        open = src.pairs[open]!;
        if (t[open + 1]?.t === "id") param = t[open + 1]!.v;
      } else if (t[open]?.t === "id") param = t[open]!.v;
      if (!param || open < 0) continue;
      let s = open;
      if (src.is(s - 1, "async", "id")) s--;
      let name: string | undefined;
      let exported: string | undefined;
      if (src.is(s - 1, "=") && src.dotted(s - 4, s - 1) === "module.exports") {
        name = "default";
        exported = "default";
      } else if (src.is(s - 1, "default", "id") && src.is(s - 2, "export", "id")) {
        name = "default";
        exported = "default";
      } else if (src.is(s - 1, "=") && t[s - 2]?.t === "id") name = t[s - 2]!.v;
      if (name)
        funcs.push({
          name,
          param,
          body: [k + 1, src.pairs[k + 1]!],
          ...(exported ? { exported } : {}),
        });
    }
  }
  for (const f of funcs)
    if (!f.exported && [...exports].some(([, local]) => local === f.name))
      f.exported = [...exports].find(([, l]) => l === f.name)![0];
  return { bindings, exports, funcs };
}

/**
 * Node servers (only where a package.json depends on Express, Fastify, NestJS, Koa or
 * hapi): Express apps and routers (route(), use() prefixes across required or imported
 * files), Fastify (route objects, register() prefixes), koa-router prefixes, hapi route
 * objects, NestJS controllers with the global prefix; fetch, axios and axios instances
 * (baseURL), got; kafkajs, amqplib and Service Bus topics; database URLs.
 */
export const nodeExtractor = defineExtractor({
  id: "node",
  version: "0.1.0",
  claims: ["**/package.json", "**/*.js", "**/*.mjs", "**/*.cjs", "**/*.ts", "**/*.mts", "**/*.cts"],
  async *scan(repo, ctx) {
    const pkgs = await serverPackages(repo);
    if (pkgs.length === 0) return;
    const em = new Emitter(repo, ctx);
    const comp = await componentGap("node", repo, ctx);
    if (comp) em.record(comp);
    const env = await dotenv(repo);
    const roots = pkgs.map(dirOf);
    const paths = (
      await listSources(repo, [
        "**/*.js",
        "**/*.mjs",
        "**/*.cjs",
        "**/*.ts",
        "**/*.mts",
        "**/*.cts",
      ])
    ).filter(
      (p) => !/\.d\.[cm]?ts$/.test(p) && roots.some((r) => r === "" || p.startsWith(`${r}/`)),
    );
    const files = new Map<string, NodeFile>();
    for (const path of paths) {
      const src = await SourceFile.parse(path, await repo.readText(path), "js", repo.parseCache);
      const envOf = (key: string) => env.get(key)?.value ?? unresolved(key);
      const ev = new Evaluator(src, {
        name: (dotted) => (dotted.startsWith("process.env.") ? envOf(dotted.slice(12)) : undefined),
        index: (recv, key) => (recv === "process.env" ? envOf(key) : undefined),
      });
      files.set(path, { src, ev, scopes: new Scopes(), ...readModule(src) });
    }
    const resolve = (from: string, spec: string): string | undefined => {
      if (!spec.startsWith(".")) return undefined;
      const parts = `${dirOf(from)}/${spec}`.split("/");
      const out: string[] = [];
      for (const p of parts) {
        if (p === "" || p === ".") continue;
        if (p === "..") out.pop();
        else out.push(p);
      }
      const base = out.join("/");
      const cands = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => `${base}/index${e}`)];
      if (/\.[cm]?js$/.test(base)) cands.push(base.replace(/\.([cm]?)js$/, ".$1ts"));
      return cands.find((c) => files.has(c));
    };

    // ---- routers and servers
    const graph = new RouteGraph();
    for (const [path, nf] of files) {
      const { src } = nf;
      for (const c of src.calls) {
        const lower = c.callee.toLowerCase();
        // What the callee was imported as, so `import e from "express"; e()` counts too.
        const root = c.callee.split(".")[0]!;
        const bound = nf.bindings.get(root);
        const spec = bound?.spec ?? root.toLowerCase();
        const bare = c.callee === root;
        let own: string | undefined;
        if (
          (spec === "express" && (bare || c.name === "Router")) ||
          (bare && !c.isNew && (c.callee === "Router" || bound?.name === "Router"))
        )
          own = "";
        else if (
          bare &&
          c.isNew &&
          (c.callee === "Router" || /^(@koa\/router|koa-router)$/.test(spec))
        ) {
          // koa-router: new Router({ prefix: "/x" })
          const o = src.arg(c, 0);
          const pre = o && src.is(o.from, "{") ? src.field(o.from, "prefix") : undefined;
          own = (pre && nf.ev.arg(pre)) || "";
        } else if (
          lower === "fastify" ||
          (spec === "fastify" && bare) ||
          lower === "hapi.server" ||
          (/^(@hapi\/hapi|hapi)$/.test(spec) &&
            (c.name === "server" || (c.isNew && c.name === "Server"))) ||
          (c.isNew && bare && (c.callee === "Koa" || spec === "koa"))
        )
          own = "";
        if (own === undefined) continue;
        const name = src.assignedTo(c);
        if (!name) continue;
        const [, end] = src.blockOf(c.start);
        nf.scopes.define(name, graph.node(`${path}#${name}@${c.start}`, own), c.start, end);
      }
      // const app = require("fastify")({ ... })
      for (const [name, list] of src.assigns)
        for (const a of list)
          if (
            src.is(a.from, "require", "id") &&
            src.str({ from: a.from + 2, to: a.from + 3 }) === "fastify" &&
            src.is(a.from + 4, "(")
          )
            nf.scopes.define(
              name,
              graph.node(`${path}#${name}@${a.at}`),
              a.at,
              src.blockOf(a.at)[1],
            );
    }
    /** The function a reference names (Fastify plugins): local, or exported by an imported module. */
    const funcRef = (
      path: string,
      a: Arg | undefined,
    ): { file: string; fn: NodeFile["funcs"][number] } | undefined => {
      if (!a) return undefined;
      const nf = files.get(path)!;
      const name = nf.src.dotted(a.from, a.to);
      const req = nf.src.callAtStart(a.from);
      let file: string | undefined;
      let exp = "default";
      if (name) {
        const local = nf.funcs.find((f) => f.name === name);
        if (local) return { file: path, fn: local };
        const b = nf.bindings.get(name);
        if (!b) return undefined;
        file = resolve(path, b.spec);
        exp = b.name;
      } else if (req?.callee === "require" && req.close === a.to - 1)
        file = resolve(path, nf.src.str(nf.src.arg(req, 0)) ?? "");
      if (!file) return undefined;
      const target = files.get(file)!;
      const fn =
        target.funcs.find((f) => f.exported === exp) ??
        target.funcs.find((f) => f.name === (target.exports.get(exp) ?? exp));
      return fn ? { file, fn } : undefined;
    };
    const pluginNode = (file: string, fn: NodeFile["funcs"][number]) => {
      const id = `${file}#fn:${fn.name}@${fn.body[0]}`;
      if (!graph.has(id)) {
        graph.node(id);
        files.get(file)!.scopes.define(fn.param, id, fn.body[0], fn.body[1]);
      }
      return id;
    };
    for (const [path, nf] of files)
      for (const c of nf.src.calls)
        if (c.name === "register") {
          const r = funcRef(path, nf.src.arg(c, 0));
          if (r) pluginNode(r.file, r.fn);
        }
    const fastifyRepo =
      /"fastify"/.test(pkgs.join(" ")) ||
      [...files.values()].some((f) => f.src.imports.some((i) => i.spec === "fastify"));
    if (fastifyRepo)
      for (const [path, nf] of files)
        for (const fn of nf.funcs)
          if (fn.exported && /^(fastify|app|server|instance|router)$/.test(fn.param))
            pluginNode(path, fn);

    /** The router an argument refers to: a local router, an imported module's export, require("./x"). */
    const routerRef = (path: string, a: Arg): string | undefined => {
      const nf = files.get(path)!;
      const name = nf.src.dotted(a.from, a.to);
      let file: string | undefined;
      let exp = "default";
      if (name) {
        const local = nf.scopes.lookup(name, a.from);
        if (local) return local;
        const b = nf.bindings.get(name);
        if (!b) return undefined;
        file = resolve(path, b.spec);
        exp = b.name;
      } else {
        const c = nf.src.callAtStart(a.from);
        if (c?.callee === "require" && c.close === a.to - 1)
          file = resolve(path, nf.src.str(nf.src.arg(c, 0)) ?? "");
        // koa: app.use(router.routes())
        else if (c && c.name === "routes" && c.close === a.to - 1)
          return nf.scopes.lookup(c.recv, c.start);
      }
      if (!file) return undefined;
      const target = files.get(file)!;
      const local = target.exports.get(exp) ?? (exp === "default" ? undefined : exp);
      return local ? target.scopes.lookup(local, Number.MAX_SAFE_INTEGER - 1) : undefined;
    };

    const routes: { node: string; method: string; path: string; file: string; line: number }[] = [];
    for (const [path, nf] of files) {
      const { src, ev, scopes } = nf;
      for (const c of src.calls) {
        const recv = c.chained ? undefined : scopes.lookup(c.recv, c.start);
        if (!recv) continue;
        if (c.name === "use") {
          let rest = c.args;
          let prefix = "";
          const first = c.args[0] ? ev.arg(c.args[0]) : undefined;
          if (first !== undefined && c.args.length > 1) {
            prefix = first;
            rest = c.args.slice(1);
          }
          for (const a of rest) {
            const child = routerRef(path, a);
            if (child && child !== recv) graph.edge(child, recv, prefix);
          }
          continue;
        }
        if (c.name === "register") {
          const r = funcRef(path, src.arg(c, 0));
          const opts = src.arg(c, 1);
          const pre = opts && src.is(opts.from, "{") ? src.field(opts.from, "prefix") : undefined;
          if (r) graph.edge(pluginNode(r.file, r.fn), recv, (pre && ev.arg(pre)) || "");
          continue;
        }
        if (c.name === "route") {
          const a = src.arg(c, 0);
          if (!a) continue;
          const p = src.tok(a.from)?.t === "str" ? ev.arg(a) : undefined;
          if (p !== undefined) {
            // Express: router.route("/x").get(h).post(h)
            for (let n = src.next(c); n; n = src.next(n))
              if (VERBS[n.name])
                routes.push({
                  node: recv,
                  method: VERBS[n.name]!,
                  path: p,
                  file: path,
                  line: n.line,
                });
            continue;
          }
          // Fastify and hapi: route({ method, url | path }) or an array of them
          const objs: number[] = [];
          if (src.is(a.from, "{")) objs.push(a.from);
          else if (src.is(a.from, "[")) {
            const end = src.pairs[a.from]!;
            for (let k = a.from + 1; k < end; k = src.pairs[k]! > k ? src.pairs[k]! + 1 : k + 1)
              if (src.is(k, "{")) objs.push(k);
          }
          for (const o of objs) {
            const m = src.field(o, "method");
            const u = src.field(o, "url") ?? src.field(o, "path");
            const up = u ? ev.arg(u) : undefined;
            if (!m || up === undefined) continue;
            const ms = src
              .strings(m.from, m.to)
              .map((s) => (s.v === "*" ? "ANY" : s.v.toUpperCase()));
            for (const method of ms)
              routes.push({ node: recv, method, path: up, file: path, line: c.line });
          }
          continue;
        }
        if (VERBS[c.name] && c.args.length >= 2) {
          const p = ev.arg(c.args[0]);
          if (p !== undefined && /^[/*]/.test(p))
            routes.push({ node: recv, method: VERBS[c.name]!, path: p, file: path, line: c.line });
        }
      }
    }

    // ---- NestJS controllers
    let globalPrefix = "";
    for (const nf of files.values())
      for (const c of nf.src.calls)
        if (c.name === "setGlobalPrefix")
          globalPrefix = nf.ev.arg(nf.src.arg(c, 0)) ?? globalPrefix;
    for (const [path, nf] of files) {
      const { src, ev } = nf;
      if (!src.imports.some((i) => i.spec.startsWith("@nestjs/"))) continue;
      const nestPaths = (a: Arg | undefined): string[] => {
        if (!a) return [""];
        if (src.is(a.from, "{")) {
          const p = src.field(a.from, "path");
          return p ? nestPaths(p) : [""];
        }
        if (src.is(a.from, "[")) return src.strings(a.from, a.to).map((s) => s.v);
        const v = ev.arg(a);
        return v === undefined ? [] : [v];
      };
      for (const c of src.calls) {
        if (!c.decorator || c.name !== "Controller") continue;
        let k = c.close + 1;
        while (k < src.toks.length && !src.is(k, "class", "id")) k++;
        while (k < src.toks.length && !src.is(k, "{")) k++;
        const end = src.pairs[k]!;
        if (end < 0) continue;
        const prefixes = nestPaths(src.arg(c, 0));
        for (const m of src.calls) {
          if (!m.decorator || !NEST_VERBS[m.name] || m.start < k || m.start > end) continue;
          for (const pre of prefixes)
            for (const p of nestPaths(src.arg(m, 0)))
              routes.push({
                node: graph.node("nest"),
                method: NEST_VERBS[m.name]!,
                path: joinPath(globalPrefix, pre, p),
                file: path,
                line: m.line,
              });
        }
      }
      for (const c of src.calls) {
        if (!c.decorator || (c.name !== "EventPattern" && c.name !== "MessagePattern")) continue;
        const a = src.arg(c, 0);
        const topic = src.str(a);
        if (a && topic) em.loose("event-subscribe", topic, path, src.tok(a.from)!.line, "callee");
      }
    }
    for (const r of routes)
      for (const prefix of graph.prefixes(r.node))
        em.endpoint(r.method, joinPath(prefix, r.path), r.file, r.line);

    // ---- outgoing calls, events and databases
    for (const [path, nf] of files) {
      const { src, ev } = nf;
      const instances = new Map<string, string | undefined>();
      for (const c of src.calls) {
        if (c.callee !== "axios.create" && c.callee !== "got.extend") continue;
        const name = src.assignedTo(c);
        const o = src.arg(c, 0);
        const b =
          o && src.is(o.from, "{")
            ? (src.field(o.from, "baseURL") ?? src.field(o.from, "prefixUrl"))
            : undefined;
        if (name) instances.set(name, b ? ev.arg(b) : undefined);
      }
      const optsMethod = (a: Arg | undefined) => {
        const m = a && src.is(a.from, "{") ? src.field(a.from, "method") : undefined;
        return m ? ev.arg(m)?.toUpperCase() : undefined;
      };
      for (const c of src.calls) {
        if (frontendCovers(path, src, c)) continue;
        let method: string | undefined;
        let url: string | undefined;
        let base: string | undefined;
        const a0 = src.arg(c, 0);
        const objectCall = a0 && src.is(a0.from, "{");
        const isClient =
          c.callee === "axios" ||
          c.callee === "got" ||
          c.recv === "axios" ||
          c.recv === "got" ||
          instances.has(c.recv) ||
          /(^|\.)httpService$/.test(c.recv);
        if (c.callee === "fetch") {
          method = optsMethod(src.arg(c, 1)) ?? "GET";
          url = ev.arg(a0);
        } else if (
          isClient &&
          (c.callee === "axios" ||
            c.callee === "got" ||
            c.name === "request" ||
            instances.has(c.callee))
        ) {
          if (objectCall) {
            const u = src.field(a0.from, "url");
            method = optsMethod(a0) ?? "GET";
            url = u ? ev.arg(u) : undefined;
          } else {
            method = optsMethod(src.arg(c, 1)) ?? "GET";
            url = ev.arg(a0);
          }
          base = instances.get(c.recv) ?? instances.get(c.callee);
        } else if (isClient && VERBS[c.name] && c.name !== "all") {
          method = VERBS[c.name];
          url = ev.arg(a0);
          base = instances.get(c.recv);
        }
        if (method && url !== undefined) em.call(method, joinUrl(base, url), path, c.line);
      }
      for (const e of events(src, ev))
        em.loose(e.kind, e.topic, path, e.line, e.kind === "event-publish" ? "caller" : "callee");
      for (const c of src.calls) {
        let a: Arg | undefined;
        const a0 = src.arg(c, 0);
        if (
          c.isNew &&
          (c.callee === "Pool" ||
            c.callee === "Client" ||
            c.callee === "pg.Pool" ||
            c.callee === "pg.Client") &&
          a0 &&
          src.is(a0.from, "{")
        )
          a = src.field(a0.from, "connectionString");
        else if (
          (c.isNew && c.callee === "Sequelize") ||
          c.callee === "mongoose.connect" ||
          c.callee === "mongoose.createConnection"
        )
          a = a0;
        const v = a ? ev.arg(a) : undefined;
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

function* events(
  src: SourceFile,
  ev: Evaluator,
): Generator<{ kind: "event-publish" | "event-subscribe"; topic: string; line: number }> {
  const kafka = src.imported("kafkajs");
  const amqp = src.imported("amqplib");
  const bus = src.imported("@azure/service-bus");
  const known = (v: string | undefined) => (v && !/[{}]/.test(v) ? v : undefined);
  const one = (a: Arg | undefined) => {
    const topic = a ? known(ev.arg(a)) : undefined;
    return a && topic ? { topic, line: src.tok(a.from)!.line } : undefined;
  };
  for (const c of src.calls) {
    const a0 = src.arg(c, 0);
    if (kafka && (c.name === "send" || c.name === "subscribe") && a0 && src.is(a0.from, "{")) {
      const kind = c.name === "send" ? "event-publish" : "event-subscribe";
      const t = one(src.field(a0.from, "topic"));
      if (t) yield { kind, ...t };
      const many = c.name === "subscribe" ? src.field(a0.from, "topics") : undefined;
      if (many)
        for (const s of src.strings(many.from, many.to)) yield { kind, topic: s.v, line: s.line };
    } else if (amqp && c.name === "publish") {
      const t = one(a0) ?? one(src.arg(c, 1));
      if (t) yield { kind: "event-publish", ...t };
    } else if (amqp && c.name === "sendToQueue") {
      const t = one(a0);
      if (t) yield { kind: "event-publish", ...t };
    } else if (amqp && c.name === "consume") {
      const t = one(a0);
      if (t) yield { kind: "event-subscribe", ...t };
    } else if (bus && c.name === "createSender") {
      const t = one(a0);
      if (t) yield { kind: "event-publish", ...t };
    } else if (bus && c.name === "createReceiver") {
      const t = one(a0);
      if (t) yield { kind: "event-subscribe", ...t };
    }
  }
}
