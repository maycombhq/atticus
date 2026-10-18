import type { CatalogRecord } from "@maycombhq/core";
import { defineExtractor } from "@maycombhq/sdk";
import { endpoint, lineAt, loose, own, read, sources, stripComments } from "./common.js";

/**
 * gRPC (ADR 0040): `.proto` services become `grpc` Endpoints, one per RPC, with pathOrTopic
 * `package.Service/Method`, method the RPC name and id `<component>.grpc.<package.service.method>`.
 * A repo serves a service when its code registers or implements it (Java `...ImplBase`, Go
 * `RegisterXServer` or an embedded `UnimplementedXServer`, Node `addService(...X.service`, Python `add_XServicer_to_server`, C#
 * `X.XBase`), or when it doesn't also call that service and isn't a library repo (a service's
 * own repo usually carries its proto; a client's vendored copy goes with a client stub).
 *
 * Generated client usage, where cheap, becomes `grpc-call` loose ends naming the service
 * (merge resolves them by service name): Java `XGrpc.newBlockingStub/newStub/newFutureStub`,
 * Go `<x>pb.NewXClient(`, Node `@grpc/grpc-js` `new <loaded>.<package>.X(address, ...)`,
 * Python `<x>_pb2_grpc.XStub(` and C# `new X.XClient(`. The package is added when a proto in
 * the repo declares the service. When the stub is assigned to a name and the repo's proto
 * declares the service, each RPC called on that name is its own loose end `package.Service/Method`
 * at the line of the call (the first letter of the method may differ in case, as in Java and
 * Node stubs); otherwise the loose end names the service. A Node client's address may be a
 * variable when the constructor is given gRPC credentials.
 */

const PROTO = ["**/*.proto"];
const CODE = [
  "**/*.java",
  "**/*.kt",
  "**/*.go",
  "**/*.ts",
  "**/*.js",
  "**/*.mjs",
  "**/*.py",
  "**/*.cs",
];

interface Rpc {
  service: string;
  pkg?: string;
  method: string;
  path: string;
  line: number;
}

/** Services and RPCs declared in a proto file. */
export function parseProto(text: string, path: string): Rpc[] {
  const clean = stripComments(text, "c");
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(clean)?.[1];
  const out: Rpc[] = [];
  for (const s of clean.matchAll(/\bservice\s+(\w+)\s*\{/g)) {
    // The service body ends at the brace that closes it (RPCs may have option bodies).
    let depth = 0;
    let end = s.index + s[0].length - 1;
    for (; end < clean.length; end++) {
      if (clean[end] === "{") depth++;
      else if (clean[end] === "}" && --depth === 0) break;
    }
    const body = clean.slice(s.index, end);
    for (const r of body.matchAll(/\brpc\s+(\w+)\s*\(/g))
      out.push({
        service: s[1]!,
        ...(pkg ? { pkg } : {}),
        method: r[1]!,
        path,
        line: lineAt(clean, s.index + r.index),
      });
  }
  return out;
}

const SERVER_MARKERS: RegExp[] = [
  /\b(\w+)Grpc\.\1ImplBase\b/g,
  /\bRegister(\w+)Server\s*\(/g,
  /\bUnimplemented(\w+)Server\b/g,
  /\baddService\s*\(\s*[\w.]*?(\w+)\.service\b/g,
  /\badd_(\w+)Servicer_to_server\s*\(/g,
  /\b(\w+)\.\1Base\b/g,
];

/** Generated client constructors by language: the service name is the first group. */
const CLIENTS: { files: RegExp; re: RegExp }[] = [
  { files: /\.(java|kt)$/, re: /\b(\w+)Grpc\s*\.\s*new(?:Blocking|Future)?Stub\s*\(/g },
  { files: /\.go$/, re: /\b\w*pb\.New(\w+)Client\s*\(/g },
  { files: /\.py$/, re: /\b\w*pb2_grpc\.(\w+)Stub\s*\(/g },
  { files: /\.cs$/, re: /\bnew\s+(\w+)\.\1Client\s*\(/g },
];
/**
 * @grpc/grpc-js: `new proto.harbor.ledger.v1.LedgerService("host:port", creds)`. The address is
 * often a variable or an environment value, so a gRPC credentials argument counts as well.
 */
const NODE_CLIENT = /\bnew\s+(\w+(?:\.\w+)*)\.(\w+)\s*\(/g;
const NODE_CREDENTIALS = /\bcredentials\s*\.\s*create\w*\s*\(|\bChannelCredentials\b/;

/** The text between the parenthesis at `open` and its closing one (or a bounded stretch). */
function argsOf(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length && i < open + 400; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1, open + 400);
}

/** Generated stub methods that are not RPCs. */
const NOT_RPC = new Set([
  "close",
  "waitForReady",
  "getChannel",
  "withDeadline",
  "withInterceptors",
]);

/**
 * The RPCs a client calls on the stub it built at `at`: the variable the constructor is assigned
 * to (`const c = ...`, `c := ...`, `this.stub = ...`), then `c.Method(` anywhere in the file.
 * Method names match the proto's RPCs ignoring the case of their first letter (Java and Node
 * stubs lowercase it). Empty when the stub isn't assigned to a name or no declared RPC is called.
 */
function methodCalls(
  clean: string,
  at: number,
  declared: string[],
): { method: string; line: number }[] {
  const start = Math.max(clean.lastIndexOf("\n", at), clean.lastIndexOf(";", at)) + 1;
  const name = /([A-Za-z_$][\w$]*)\s*(?::=|=)\s*(?:await\s+)?$/.exec(clean.slice(start, at))?.[1];
  if (!name || declared.length === 0) return [];
  const out: { method: string; line: number }[] = [];
  const re = new RegExp(
    `(?<![\\w$])(?:(?:this|self)\\s*\\.\\s*)?${name}\\s*\\.\\s*([A-Za-z_]\\w*)\\s*\\(`,
    "g",
  );
  for (const m of clean.matchAll(re)) {
    if (NOT_RPC.has(m[1]!)) continue;
    const rpc = declared.find((d) => lowerFirst(d) === lowerFirst(m[1]!));
    if (rpc) out.push({ method: rpc, line: lineAt(clean, m.index) });
  }
  return out;
}

const lowerFirst = (s: string) => s.slice(0, 1).toLowerCase() + s.slice(1);

export const grpcExtractor = defineExtractor({
  id: "grpc",
  version: "0.1.1",
  claims: [...PROTO, ...CODE],
  async *scan(repo, ctx) {
    const comp = own(repo, ctx);
    const rpcs: Rpc[] = [];
    for (const path of await sources(repo, PROTO)) {
      const text = await read(repo, ctx, path);
      if (text !== undefined) rpcs.push(...parseProto(text, path));
    }
    const pkgOf = new Map(rpcs.map((r) => [r.service, r.pkg]));
    const served = new Map<string, { path: string; line: number }>();
    const calls: {
      service: string;
      path: string;
      line: number;
      /** The RPCs called on this client, when its proto is in the repo and the stub is a named variable. */
      methods: { method: string; line: number }[];
    }[] = [];
    const rpcsOf = (service: string) =>
      rpcs.filter((r) => r.service === service.split(".").pop()).map((r) => r.method);
    for (const path of await sources(repo, CODE)) {
      const text = await read(repo, ctx, path);
      if (
        text === undefined ||
        !/grpc|Grpc|Servicer|Unimplemented\w+Server|Server\(|Client\(|Stub\(/.test(text)
      )
        continue;
      const clean = stripComments(text, path.endsWith(".py") ? "hash" : "c");
      for (const re of SERVER_MARKERS)
        for (const m of clean.matchAll(re))
          if (!served.has(m[1]!)) served.set(m[1]!, { path, line: lineAt(clean, m.index) });
      const isNode = /\.(ts|js|mjs)$/.test(path);
      if (isNode && /@grpc\/grpc-js/.test(clean)) {
        for (const m of clean.matchAll(NODE_CLIENT)) {
          const args = argsOf(clean, m.index + m[0].length - 1);
          if (!/^\s*["'`]/.test(args) && !NODE_CREDENTIALS.test(args)) continue;
          const pkg = m[1]!.split(".").slice(1).join(".");
          const service = pkg ? `${pkg}.${m[2]!}` : m[2]!;
          calls.push({
            service,
            path,
            line: lineAt(clean, m.index),
            methods: methodCalls(clean, m.index, rpcsOf(service)),
          });
        }
      }
      for (const c of CLIENTS) {
        if (!c.files.test(path)) continue;
        for (const m of clean.matchAll(c.re))
          calls.push({
            service: m[1]!,
            path,
            line: lineAt(clean, m.index),
            methods: methodCalls(clean, m.index, rpcsOf(m[1]!)),
          });
      }
    }
    const short = (s: string) => s.split(".").pop()!;
    const called = new Set(calls.map((c) => short(c.service)));
    const library = ctx.repoType === "library";

    const out: CatalogRecord[] = [];
    for (const r of rpcs) {
      const impl = served.get(r.service);
      if (!impl && (called.has(r.service) || library)) continue;
      const full = r.pkg ? `${r.pkg}.${r.service}` : r.service;
      const e = endpoint({
        repo,
        component: comp,
        endpointType: "grpc",
        prefix: "grpc",
        name: `${full}.${r.method}`,
        method: r.method,
        pathOrTopic: `${full}/${r.method}`,
        source: "spec",
        path: r.path,
        line: r.line,
      });
      if (impl)
        e.evidence.push({
          source: "code",
          repo: repo.name,
          path: impl.path,
          line: impl.line,
          side: "callee",
        });
      out.push(e);
    }
    yield* out;
    const seen = new Set<string>();
    for (const c of calls) {
      if (served.has(short(c.service))) continue;
      const pkg = c.service.includes(".") ? undefined : pkgOf.get(c.service);
      const raw = pkg ? `${pkg}.${c.service}` : c.service;
      // With the proto at hand, the RPCs the client calls (each at the line of its call); the
      // service as a whole when none is seen.
      const targets =
        c.methods.length > 0
          ? c.methods.map((x) => ({ raw: `${raw}/${x.method}`, line: x.line }))
          : [{ raw, line: c.line }];
      for (const t of targets) {
        const key = `${t.raw}|${c.path}|${t.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        yield loose(repo, comp, "grpc-call", t.raw, c.path, t.line);
      }
    }
  },
});
