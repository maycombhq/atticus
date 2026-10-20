import type { CatalogRecord } from "@maycombhq/core";
import { defineExtractor } from "@maycombhq/sdk";
import {
  assignedName,
  callOf,
  callsIn,
  descendants,
  lineOf,
  namePath,
  stringValue,
  withTree,
  type CodeCall,
  type Node,
} from "../lang/code-tree.js";
import { syntaxLanguageOf } from "../lang/syntax.js";
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

/** The last two names of a dotted name: `io.x.LedgerGrpc.LedgerImplBase` → [LedgerGrpc, LedgerImplBase]. */
const lastTwo = (p: string[] | undefined) => (p && p.length >= 2 ? p.slice(-2) : undefined);

/**
 * The services a file serves, in the order of the markers: Java `XGrpc.XImplBase`, Go
 * `RegisterXServer(...)` and an `UnimplementedXServer`, Node `addService(X.service, ...)`, Python
 * `add_XServicer_to_server(...)` and C# `X.XBase`.
 */
function servedIn(root: Node, calls: CodeCall[]): { service: string; line: number }[][] {
  const implBase: { service: string; line: number }[] = [];
  const csBase: { service: string; line: number }[] = [];
  const unimplemented: { service: string; line: number }[] = [];
  for (const n of descendants(root)) {
    const two = /identifier$|type$|access|expression$|qualified_name/.test(n.type)
      ? lastTwo(namePath(n))
      : undefined;
    if (two) {
      const grpc = /^(\w+)Grpc$/.exec(two[0]!)?.[1];
      if (grpc && two[1] === `${grpc}ImplBase`) implBase.push({ service: grpc, line: lineOf(n) });
      if (two[1] === `${two[0]}Base`) csBase.push({ service: two[0]!, line: lineOf(n) });
    }
    const u = /identifier$/.test(n.type) ? /^Unimplemented(\w+)Server$/.exec(n.text) : null;
    if (u) unimplemented.push({ service: u[1]!, line: lineOf(n) });
  }
  const by = (re: RegExp) =>
    calls.flatMap((c) => {
      const m = re.exec(c.name);
      return m ? [{ service: m[1]!, line: c.line }] : [];
    });
  const addService = calls.flatMap((c) => {
    const p = namePath(c.args[0]);
    return c.name === "addService" && p && p.length >= 2 && p.at(-1) === "service"
      ? [{ service: p.at(-2)!, line: c.line }]
      : [];
  });
  return [
    implBase,
    by(/^Register(\w+)Server$/),
    unimplemented,
    addService,
    by(/^add_(\w+)Servicer_to_server$/),
    csBase,
  ];
}

/** Does a Node constructor call pass gRPC credentials (`credentials.createInsecure()`, ChannelCredentials)? */
const passesCredentials = (c: CodeCall) =>
  c.args.some((a) =>
    [...descendants(a)].some((n) => {
      const cc = callOf(n);
      if (cc && cc.path?.at(-2) === "credentials" && cc.name.startsWith("create")) return true;
      return /identifier$/.test(n.type) && n.text === "ChannelCredentials";
    }),
  );

/** Generated client constructors: the service a call builds a client for, by language. */
function clientService(c: CodeCall, path: string): string | undefined {
  const recv = namePath(c.receiver)?.at(-1);
  if (/\.(java|kt)$/.test(path))
    return recv && /^new(Blocking|Future)?Stub$/.test(c.name)
      ? /^(\w+)Grpc$/.exec(recv)?.[1]
      : undefined;
  if (path.endsWith(".go"))
    return recv && /pb$/.test(recv) && c.receiver?.childCount === 0
      ? /^New(\w+)Client$/.exec(c.name)?.[1]
      : undefined;
  if (path.endsWith(".py"))
    return recv && /pb2_grpc$/.test(recv) && c.receiver?.childCount === 0
      ? /^(\w+)Stub$/.exec(c.name)?.[1]
      : undefined;
  if (path.endsWith(".cs")) {
    const two = c.isNew && c.path?.length === 2 ? c.path : undefined;
    return two && two[1] === `${two[0]}Client` ? two[0] : undefined;
  }
  return undefined;
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
 * The RPCs a client calls on the stub `stub` builds: the name the constructor is assigned to
 * (`const c = ...`, `c := ...`, `this.stub = ...`), then `c.Method(...)` anywhere in the file.
 * Method names match the proto's RPCs ignoring the case of their first letter (Java and Node
 * stubs lowercase it). Empty when the stub isn't assigned to a name or no declared RPC is called.
 */
function methodCalls(
  stub: CodeCall,
  calls: CodeCall[],
  declared: string[],
): { method: string; line: number }[] {
  const name = assignedName(stub.node);
  if (!name || declared.length === 0) return [];
  const out: { method: string; line: number }[] = [];
  for (const c of calls) {
    const on = namePath(c.receiver);
    const named =
      on &&
      (on.length === 1
        ? on[0] === name
        : on.length === 2 && /^(this|self)$/.test(on[0]!) && on[1] === name);
    if (!named || NOT_RPC.has(c.name)) continue;
    const rpc = declared.find((d) => lowerFirst(d) === lowerFirst(c.name));
    if (rpc) out.push({ method: rpc, line: lineOf(c.receiver!) });
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
      const lang = syntaxLanguageOf(path);
      if (!lang) continue;
      await withTree(
        lang,
        text,
        (root) => {
          const all = callsIn(root);
          for (const list of servedIn(root, all))
            for (const s of list)
              if (!served.has(s.service)) served.set(s.service, { path, line: s.line });
          const isNode = /\.(ts|js|mjs)$/.test(path);
          const grpcJs = [...descendants(root)].some((n) => stringValue(n) === "@grpc/grpc-js");
          if (isNode && grpcJs)
            for (const c of all) {
              if (!c.isNew || !c.path || c.path.length < 2) continue;
              const first = c.args[0];
              if (!(first && stringValue(first, true) !== undefined) && !passesCredentials(c))
                continue;
              const pkg = c.path.slice(1, -1).join(".");
              const service = pkg ? `${pkg}.${c.name}` : c.name;
              calls.push({
                service,
                path,
                line: lineOf(c.node),
                methods: methodCalls(c, all, rpcsOf(service)),
              });
            }
          for (const c of all) {
            const service = clientService(c, path);
            if (service)
              calls.push({
                service,
                path,
                line: lineOf(c.node),
                methods: methodCalls(c, all, rpcsOf(service)),
              });
          }
        },
        { cache: repo.parseCache, path },
      );
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
