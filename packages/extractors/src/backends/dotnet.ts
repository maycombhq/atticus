import { defineExtractor, type RepoHandle } from "@maycombhq/sdk";
import { flattenYaml, type ConfigValue } from "../lang/config.js";
import {
  componentGap,
  connectionUrl,
  dotenv,
  Emitter,
  Evaluator,
  joinPath,
  joinUrl,
  listSources,
  RouteGraph,
  Scopes,
  SourceFile,
  unresolved,
  type Arg,
  type SrcCall,
} from "./shared.js";

const HTTP_ATTRS: Record<string, string> = {
  HttpGet: "GET",
  HttpPost: "POST",
  HttpPut: "PUT",
  HttpDelete: "DELETE",
  HttpPatch: "PATCH",
  HttpHead: "HEAD",
  HttpOptions: "OPTIONS",
};
const REFIT_ATTRS: Record<string, string> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Delete: "DELETE",
  Patch: "PATCH",
  Head: "HEAD",
  Options: "OPTIONS",
};
const MAP_CALLS: Record<string, string> = {
  MapGet: "GET",
  MapPost: "POST",
  MapPut: "PUT",
  MapDelete: "DELETE",
  MapPatch: "PATCH",
  Map: "ANY",
};
const CLIENT_CALLS: Record<string, string> = {
  GetAsync: "GET",
  GetStringAsync: "GET",
  GetStreamAsync: "GET",
  GetByteArrayAsync: "GET",
  GetFromJsonAsync: "GET",
  PostAsync: "POST",
  PostAsJsonAsync: "POST",
  PutAsync: "PUT",
  PutAsJsonAsync: "PUT",
  PatchAsync: "PATCH",
  PatchAsJsonAsync: "PATCH",
  DeleteAsync: "DELETE",
  DeleteFromJsonAsync: "DELETE",
};
const TYPE_KW = new Set(["class", "interface", "record", "struct"]);

interface Attr {
  name: string;
  /** Positional and named (`Name = x` or `name: x`) arguments. */
  args: Arg[];
  line: number;
}
interface TypeDecl {
  name: string;
  kind: string;
  attrs: Attr[];
  bases: string[];
  body: [number, number];
}
interface Member {
  name: string;
  attrs: Attr[];
  at: number;
  parent?: TypeDecl;
}

/** Attributes, the types they sit on and their members. */
function structure(src: SourceFile): { types: TypeDecl[]; members: Member[] } {
  const t = src.toks;
  const types: TypeDecl[] = [];
  const attrsAt = new Map<number, Attr[]>();
  const members: { name: string; attrs: Attr[]; at: number }[] = [];
  let pending: Attr[] = [];
  for (let k = 0; k < t.length; k++) {
    // ---- attribute groups: [A, B("x")] at the start of a declaration
    if (src.is(k, "[") && src.pairs[k]! > k) {
      const prev = t[k - 1];
      if (!prev || (prev.t === "p" && [";", "{", "}", "]"].includes(prev.v))) {
        const close = src.pairs[k]!;
        pending.push(...attrGroup(src, k, close));
        k = close;
        if (src.is(k + 1, "[")) continue;
        // The declaration that follows: a type, or a member named before its "(".
        let j = k + 1;
        let kw = -1;
        let name: string | undefined;
        for (; j < t.length; j++) {
          const v = t[j]!;
          if (v.t === "id" && TYPE_KW.has(v.v) && t[j + 1]?.t === "id") {
            kw = j;
            break;
          }
          if (v.t === "p" && ["{", ";", "=>", "="].includes(v.v)) break;
          if (src.is(j, "(")) {
            let n = j - 1;
            if (src.is(n, ">")) {
              while (n > k && !src.is(n, "<")) n--;
              n--;
            }
            if (t[n]?.t === "id") name = t[n]!.v;
            break;
          }
        }
        if (kw >= 0) attrsAt.set(kw, pending);
        else if (name) members.push({ name, attrs: pending, at: k + 1 });
        pending = [];
        continue;
      }
    }
    // ---- type declarations
    const v = t[k]!;
    if (v.t === "id" && TYPE_KW.has(v.v) && t[k + 1]?.t === "id" && !src.is(k - 1, ".")) {
      const bases: string[] = [];
      let j = k + 2;
      let inBases = false;
      let angle = 0;
      for (; j < t.length; j++) {
        if (src.is(j, "{") || src.is(j, ";")) break;
        if (src.is(j, "(")) {
          j = Math.max(j, src.pairs[j]!);
          continue;
        }
        if (src.is(j, "<")) angle++;
        else if (src.is(j, ">")) angle--;
        else if (src.is(j, ":") && angle === 0) inBases = true;
        else if (src.is(j, "where", "id")) inBases = false;
        else if (inBases && angle === 0 && t[j]!.t === "id" && !src.is(j + 1, "."))
          bases.push(t[j]!.v);
      }
      if (src.is(j, "{") && src.pairs[j]! > j)
        types.push({
          name: t[k + 1]!.v,
          kind: v.v,
          attrs: attrsAt.get(k) ?? [],
          bases,
          body: [j, src.pairs[j]!],
        });
    }
  }
  const inner = (at: number) =>
    types
      .filter((ty) => ty.body[0] < at && at < ty.body[1])
      .sort((a, b) => b.body[0] - a.body[0])[0];
  return {
    types,
    members: members.map((m) => {
      const parent = inner(m.at);
      return parent ? { ...m, parent } : m;
    }),
  };
}

function attrGroup(src: SourceFile, open: number, close: number): Attr[] {
  const out: Attr[] = [];
  let k = open + 1;
  while (k < close) {
    // Optional target: [assembly: X], [return: Y]
    if (src.tok(k)?.t === "id" && src.is(k + 1, ":")) k += 2;
    let name = "";
    const line = src.tok(k)?.line ?? 0;
    while (k < close && src.tok(k)?.t === "id") {
      name = src.tok(k)!.v;
      k++;
      if (src.is(k, ".")) k++;
      else break;
    }
    let args: Arg[] = [];
    if (src.is(k, "(")) {
      const c = src.callAtOpen(k);
      args = (c?.args ?? []).map((a) =>
        !a.name && src.tok(a.from)?.t === "id" && src.is(a.from + 1, "=")
          ? { name: src.tok(a.from)!.v, from: a.from + 2, to: a.to }
          : a,
      );
      k = src.pairs[k]! + 1;
    }
    if (name) out.push({ name: name.replace(/Attribute$/, ""), args, line });
    while (k < close && !src.is(k, ",")) k++;
    k++;
  }
  return out;
}

/** appsettings.json, then appsettings.{Environment}.json for keys the base doesn't set. */
async function appsettings(repo: RepoHandle): Promise<Map<string, ConfigValue>> {
  const files = await listSources(repo, ["**/appsettings.json", "**/appsettings.*.json"]);
  files.sort(
    (a, b) => a.split("/").pop()!.length - b.split("/").pop()!.length || a.localeCompare(b),
  );
  const out = new Map<string, ConfigValue>();
  for (const f of files) {
    const flat = flattenYaml(stripJsonComments(await repo.readText(f)), f);
    for (const [k, v] of flat) if (!out.has(k.toLowerCase())) out.set(k.toLowerCase(), v);
  }
  return out;
}

/** Remove // and /* *\/ comments outside strings, keeping line breaks so lines still match. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") out += "\n";
        i++;
      }
      i++;
    } else out += c;
  }
  return out;
}

const configKey = (k: string) => k.replace(/__/g, ":").replace(/:/g, ".").toLowerCase();
const isConfig = (recv: string) => /(^|\.)_?config(uration)?$/i.test(recv);

/** Route template tokens: [controller] and [action], lower-cased so callers' paths match. */
const tokens = (tpl: string, controller: string, action: string) =>
  tpl
    .replace(/\[controller\]/gi, controller.toLowerCase())
    .replace(/\[action\]/gi, action.toLowerCase());

const combine = (prefix: string, tpl: string) =>
  /^~?\//.test(tpl) ? joinPath(tpl.replace(/^~/, "")) : joinPath(prefix, tpl);

/**
 * ASP.NET Core and .NET clients: controllers ([ApiController], [Route] with [controller]
 * and [action] tokens, [HttpGet("{id}")]...), minimal APIs (MapGet, MapGroup), HttpClient
 * calls with base addresses from typed or named client registration (resolved from
 * appsettings.json and appsettings.{env}.json), Refit interfaces, Confluent.Kafka, Service
 * Bus and RabbitMQ topics, and ConnectionStrings as database URLs without credentials.
 */
export const dotnetExtractor = defineExtractor({
  id: "dotnet",
  version: "0.1.0",
  claims: ["**/*.cs", "**/*.csproj", "**/*.sln", "**/appsettings*.json"],
  async *scan(repo, ctx) {
    const em = new Emitter(repo, ctx);
    const comp = await componentGap("dotnet", repo, ctx);
    if (comp) em.record(comp);
    const config = await appsettings(repo);
    const env = await dotenv(repo);
    const files: { path: string; src: SourceFile; ev: Evaluator }[] = [];
    for (const path of await listSources(repo, ["**/*.cs"])) {
      const src = await SourceFile.parse(path, await repo.readText(path), "csharp");
      const ev = new Evaluator(src, {
        index: (recv, key) =>
          isConfig(recv) ? (config.get(configKey(key))?.value ?? unresolved(key)) : undefined,
        call: (c, e) => {
          const key = e.file.str(e.file.arg(c, 0));
          if (!key) return undefined;
          if (c.name === "GetValue" && isConfig(c.recv))
            return config.get(configKey(key))?.value ?? unresolved(key);
          if (c.name === "GetConnectionString")
            return config.get(configKey(`ConnectionStrings:${key}`))?.value ?? unresolved(key);
          if (c.callee === "Environment.GetEnvironmentVariable")
            return env.get(key)?.value ?? unresolved(key);
          return undefined;
        },
      });
      files.push({ path, src, ev });
    }

    // ---- client registration: AddHttpClient<T>(c => c.BaseAddress = ...), AddRefitClient<T>, RestService.For<T>(url)
    const typedBase = new Map<string, string>();
    const namedBase = new Map<string, string>();
    const refitTypes = new Set<string>();
    const registered = new Map<string, [number, number][]>();
    for (const { path, src, ev } of files) {
      for (const c of src.calls) {
        const refit = c.name === "AddRefitClient" || c.callee === "RestService.For";
        if (c.name !== "AddHttpClient" && !refit) continue;
        if (refit) for (const g of c.generics) refitTypes.add(g);
        let end = c.start;
        while (
          end < src.toks.length &&
          !src.is(end, ";") &&
          !(src.is(end, "}") && src.pairs[end]! < c.start)
        ) {
          if (src.is(end, "(") || src.is(end, "{")) end = Math.max(end, src.pairs[end]!);
          end++;
        }
        const ranges = registered.get(path) ?? [];
        ranges.push([c.start, end]);
        registered.set(path, ranges);
        let base: string | undefined;
        if (c.callee === "RestService.For") base = ev.arg(src.arg(c, 0));
        for (let k = c.open; k < end && base === undefined; k++)
          if (src.is(k, "BaseAddress", "id") && src.is(k + 1, "="))
            base = ev.value(k + 2, src.exprEnd(k + 2));
        if (base === undefined) continue;
        for (const g of c.generics) if (!typedBase.has(g)) typedBase.set(g, base);
        const named = c.name === "AddHttpClient" ? src.str(src.arg(c, 0)) : undefined;
        if (named && !namedBase.has(named)) namedBase.set(named, base);
      }
    }

    const graph = new RouteGraph();
    for (const { path, src, ev } of files) {
      const { types, members } = structure(src);
      const usesRefit = src.imported("Refit") || src.mentions("Refit");

      // ---- controllers
      for (const m of members) {
        const ty = m.parent;
        if (!ty || ty.kind !== "class") continue;
        const isController =
          ty.attrs.some((a) => a.name === "ApiController") ||
          ty.name.endsWith("Controller") ||
          ty.bases.some((b) => b === "ControllerBase" || b === "Controller");
        if (!isController) continue;
        const controller = ty.name.replace(/Controller$/, "");
        const classRoutes = ty.attrs
          .filter((a) => a.name === "Route")
          .map((a) => ev.arg(routeArg(a)) ?? "");
        const prefixes = (classRoutes.length ? classRoutes : [""]).map((r) =>
          tokens(r, controller, m.name),
        );
        const methodRoutes = m.attrs
          .filter((a) => a.name === "Route")
          .map((a) => ({ tpl: ev.arg(routeArg(a)) ?? "", line: a.line }));
        const verbs: { method: string; tpl?: string; line: number }[] = [];
        for (const a of m.attrs) {
          if (HTTP_ATTRS[a.name]) {
            const arg = routeArg(a);
            verbs.push({
              method: HTTP_ATTRS[a.name]!,
              ...(arg ? { tpl: ev.arg(arg) ?? "" } : {}),
              line: a.line,
            });
          } else if (a.name === "AcceptVerbs")
            for (const s of a.args.filter((x) => !x.name)) {
              const v = src.str(s);
              if (v) verbs.push({ method: v.toUpperCase(), line: a.line });
            }
        }
        if (verbs.length === 0 && methodRoutes.length === 0) continue;
        const emit = (method: string, tpl: string, line: number) => {
          for (const p of prefixes)
            em.endpoint(method, combine(p, tokens(tpl, controller, m.name)), path, line);
        };
        if (verbs.length === 0) for (const r of methodRoutes) emit("ANY", r.tpl, r.line);
        for (const v of verbs) {
          if (v.tpl !== undefined) emit(v.method, v.tpl, v.line);
          else if (methodRoutes.length) for (const r of methodRoutes) emit(v.method, r.tpl, v.line);
          else emit(v.method, "", v.line);
        }
      }

      // ---- minimal APIs
      const scopes = new Scopes();
      /** The route group a call's result is: MapGroup adds a prefix, other builder calls pass it on. */
      const groupNode = (c: SrcCall): string => {
        const parent = c.chained
          ? groupNode(c.chained)
          : (scopes.lookup(c.recv, c.start) ?? graph.node("root"));
        if (c.name !== "MapGroup") return parent;
        const id = graph.node(`${path}@${c.open}`);
        graph.edge(id, parent, ev.arg(src.arg(c, 0, "prefix")) ?? "");
        return id;
      };
      for (const c of src.calls) {
        if (c.name === "MapGroup") {
          const name = src.assignedTo(c);
          if (name) scopes.define(name, groupNode(c), c.start);
          continue;
        }
        let methods: string[];
        if (MAP_CALLS[c.name]) methods = [MAP_CALLS[c.name]!];
        else if (c.name === "MapMethods") {
          const m = src.arg(c, 1);
          methods = m ? src.strings(m.from, m.to).map((s) => s.v.toUpperCase()) : [];
        } else continue;
        const route = ev.arg(src.arg(c, 0, "pattern"));
        if (route === undefined || (c.name === "Map" && !route.startsWith("/"))) continue;
        const parent = c.chained
          ? groupNode(c.chained)
          : (scopes.lookup(c.recv, c.start) ?? graph.node("root"));
        for (const prefix of graph.prefixes(parent))
          for (const m of methods) em.endpoint(m, joinPath(prefix, route), path, c.line);
      }

      // ---- HttpClient calls
      const inside = (at: number) =>
        types
          .filter((ty) => ty.body[0] < at && at < ty.body[1])
          .sort((a, b) => b.body[0] - a.body[0])[0];
      const regs = registered.get(path) ?? [];
      const bodyBase = new Map<TypeDecl | undefined, string>();
      for (let k = 0; k < src.toks.length; k++) {
        if (!(src.is(k, "BaseAddress", "id") && src.is(k + 1, "="))) continue;
        if (regs.some(([a, b]) => a <= k && k <= b)) continue;
        const ty = inside(k);
        const v = ev.value(k + 2, src.exprEnd(k + 2));
        if (v !== undefined && !bodyBase.has(ty)) bodyBase.set(ty, v);
      }
      const baseAt = (c: SrcCall): string | undefined => {
        let root = c;
        while (root.chained) root = root.chained;
        if (root !== c && root.name === "CreateClient") {
          const n = src.str(src.arg(root, 0));
          if (n && namedBase.has(n)) return namedBase.get(n);
        }
        const ty = inside(c.start);
        if (ty && typedBase.has(ty.name)) return typedBase.get(ty.name);
        for (let k = ty ? ty.body[0] : 0; k < (ty ? ty.body[1] : src.toks.length); k++)
          if (src.is(k, "CreateClient", "id") && src.is(k + 1, "(")) {
            const n = src.str(src.arg(src.callAtOpen(k + 1)!, 0));
            if (n && namedBase.has(n)) return namedBase.get(n);
          }
        return bodyBase.get(ty) ?? bodyBase.get(undefined);
      };
      for (const c of src.calls) {
        let method: string | undefined;
        let urlArg: Arg | undefined;
        const viaFactory = c.chained?.name === "CreateClient";
        if (
          CLIENT_CALLS[c.name] &&
          (viaFactory || (!c.chained && /http|client/i.test(c.recv.split(".").pop() ?? "")))
        ) {
          method = CLIENT_CALLS[c.name];
          urlArg = src.arg(c, 0, "requestUri");
        } else if (c.isNew && c.name === "HttpRequestMessage" && c.args.length >= 2) {
          const m = src.arg(c, 0);
          const dotted = m ? src.dotted(m.from, m.to) : undefined;
          if (dotted?.startsWith("HttpMethod.")) method = dotted.slice(11).toUpperCase();
          else if (m) {
            const inner = src.callAtStart(m.from + 1);
            if (src.is(m.from, "new", "id") && inner?.name === "HttpMethod")
              method = ev.arg(src.arg(inner, 0))?.toUpperCase();
          }
          urlArg = src.arg(c, 1);
        }
        if (!method || !urlArg) continue;
        const url = ev.arg(urlArg);
        if (url !== undefined) em.call(method, joinUrl(baseAt(c), url), path, c.line);
      }

      // ---- Refit interfaces
      for (const m of members) {
        const ty = m.parent;
        if (!ty || ty.kind !== "interface" || !(refitTypes.has(ty.name) || usesRefit)) continue;
        for (const a of m.attrs) {
          const method = REFIT_ATTRS[a.name];
          const tpl = method ? ev.arg(a.args.find((x) => !x.name)) : undefined;
          if (method && tpl !== undefined)
            em.call(method, joinUrl(typedBase.get(ty.name), tpl), path, a.line);
        }
      }

      // ---- events
      for (const e of events(src, ev))
        em.loose(e.kind, e.topic, path, e.line, e.kind === "event-publish" ? "caller" : "callee");
    }

    // ---- connection strings
    const csproj = (await listSources(repo, ["**/*.csproj"])).map((p) => repo.readText(p));
    const packages = (await Promise.all(csproj)).join("\n");
    for (const [key, v] of [...config.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (!key.startsWith("connectionstrings.")) continue;
      const scheme = /Npgsql/i.test(packages)
        ? "postgresql"
        : /MySql|Pomelo/i.test(packages)
          ? "mysql"
          : /SqlClient|SqlServer/i.test(packages)
            ? "sqlserver"
            : /Oracle/i.test(packages)
              ? "oracle"
              : /(^|;)\s*Host\s*=/i.test(v.value)
                ? "postgresql"
                : "sqlserver";
      const url = connectionUrl(v.value, scheme);
      if (url) em.loose("db-connection", url, v.file, v.line, "caller", "config");
    }
    yield* em.out;
  },
});

/** The template of [Route("x")] or [HttpGet("x")] / [HttpGet(template: "x")] / [HttpGet(Template = "x")]. */
function routeArg(a: Attr): Arg | undefined {
  return a.args.find((x) => !x.name) ?? a.args.find((x) => x.name?.toLowerCase() === "template");
}

function* events(
  src: SourceFile,
  ev: Evaluator,
): Generator<{ kind: "event-publish" | "event-subscribe"; topic: string; line: number }> {
  const kafka =
    src.imported("Confluent.Kafka") ||
    src.toks.some((t, k) => t.v === "Confluent" && src.dotted(k, k + 3) === "Confluent.Kafka");
  const bus =
    src.imports.some((i) => i.spec.includes("ServiceBus")) ||
    src.toks.some((t) => t.t === "id" && t.v.includes("ServiceBus"));
  const known = (v: string | undefined) => (v && !/[{}]/.test(v) ? v : undefined);
  const one = (a: Arg | undefined) => {
    const topic = a ? known(ev.arg(a)) : undefined;
    return a && topic ? { topic, line: src.tok(a.from)!.line } : undefined;
  };
  for (const c of src.calls) {
    if (kafka && (c.name === "ProduceAsync" || c.name === "Produce")) {
      const t = one(src.arg(c, 0, "topic"));
      if (t) yield { kind: "event-publish", ...t };
    } else if (kafka && c.name === "Subscribe") {
      const a = src.arg(c, 0);
      if (!a) continue;
      const lits = src.strings(a.from, a.to);
      if (a.to - a.from === 1 || lits.length === 0) {
        const t = one(a);
        if (t) yield { kind: "event-subscribe", ...t };
      } else for (const s of lits) yield { kind: "event-subscribe", topic: s.v, line: s.line };
    } else if (bus && c.name === "CreateSender") {
      const t = one(src.arg(c, 0, "queueOrTopicName"));
      if (t) yield { kind: "event-publish", ...t };
    } else if (bus && /^Create(Session)?(Processor|Receiver)$/.test(c.name)) {
      const t = one(src.arg(c, 0));
      if (t) yield { kind: "event-subscribe", ...t };
    } else if (c.name === "BasicPublish" || c.name === "BasicPublishAsync") {
      const ex = one(src.arg(c, 0, "exchange"));
      const t = ex ?? one(src.arg(c, 1, "routingKey"));
      if (t) yield { kind: "event-publish", ...t };
    } else if (c.name === "BasicConsume" || c.name === "BasicConsumeAsync") {
      const t = one(src.arg(c, 0, "queue"));
      if (t) yield { kind: "event-subscribe", ...t };
    }
  }
}
