import { createHash } from "node:crypto";
import { FrameworkModel, readTarGz, type FrameworkSource } from "@maycombhq/core";
import type { RepoHandle } from "@maycombhq/sdk";

/**
 * Learning a framework model (ADR 0055) from a JavaScript or TypeScript framework,
 * deterministically: from its source repo (learnJsFramework) or its published package's
 * typings (learnJsFrameworkFromTarball, an `npm pack` or registry .tgz). Nothing is run.
 *
 * What is read, from every exported function and every method of an exported client or router
 * instance (`export const lantern = new LanternClient()`, `export declare const router: Router`):
 * its parameters, by name, positional or as the properties of an object parameter (an inline
 * type, a destructured parameter, or a named interface or type alias in the package):
 *
 * - a path (path, url, uri, endpoint, route) and a method (method, verb), or a verb as the
 *   function's name (`get(path)`): an HTTP call, with its service (service, target) when it
 *   names one; with a handler (handler, callback) instead, a route the code serves;
 * - a topic (topic, channel, event, subject, queue) with a publishing or subscribing name
 *   (publish, emit, send; subscribe, on, listen, consume): an event or queue.
 *
 * And exported string constants, as NAME and Object.KEY. Every entry's source is `code`, with
 * the file (and the tarball and its checksum). What neither can say, a service id's base URL,
 * is returned in `notes`.
 */

type Part = { arg: number; key?: string } | { value: string };

interface Slot {
  name: string;
  part: Part;
}

const ROLE = {
  service: /^(service|serviceId|serviceName|target|system)$/i,
  method: /^(method|verb|httpMethod)$/i,
  path: /^(path|url|uri|endpoint|route)$/i,
  topic: /^(topic|channel|event|eventName|subject|queue)$/i,
  handler: /^(handler|callback|cb|fn|action|controller|listener|resolve)$/i,
};
const VERB = /^(get|post|put|delete|patch)(?![a-z])/i;
const PUBLISH = /^(publish|emit|send|produce)(?![a-z])/i;
const SUBSCRIBE = /^(subscribe|on|listen|consume)(?![a-z])/i;
const SKIP =
  /(^|\/)(node_modules|coverage|test|tests|__tests__|__mocks__|e2e|\.storybook)\/|\.(test|spec|stories)\.[cm]?[jt]sx?$/;
const FILES = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].map((e) => `**/*.${e}`);

/**
 * The text with comments blanked (`code`) and, in `mask`, string contents blanked too, both
 * keeping every offset and line: structure is read from the mask, values from the code.
 */
function blank(text: string): { code: string; mask: string } {
  const code = text.split("");
  const mask = text.split("");
  for (let i = 0; i < text.length;) {
    const c = text[i]!;
    const n = text[i + 1];
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") code[i] = mask[i++] = " ";
    } else if (c === "/" && n === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) if (text[i] !== "\n") code[i] = mask[i] = " ";
    } else if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === "\\") mask[i++] = " ";
        if (text[i] !== "\n") mask[i] = " ";
        i++;
      }
      i++;
    } else i++;
  }
  return { code: code.join(""), mask: mask.join("") };
}

/** The offset just past the bracket matching the one at `open`, in the mask. */
function close(mask: string, open: number): number {
  const o = mask[open]!;
  const c = o === "(" ? ")" : o === "{" ? "}" : o === "<" ? ">" : "]";
  let depth = 0;
  for (let i = open; i < mask.length; i++) {
    const ch = mask[i]!;
    if (ch === o) depth++;
    else if (ch === c && !(c === ">" && mask[i - 1] === "=")) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return mask.length;
}

/** Split [from, to) of the mask at top-level separators, as offset ranges. */
function splitTop(mask: string, from: number, to: number, seps: RegExp): [number, number][] {
  const out: [number, number][] = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    const ch = mask[i]!;
    if ("({[<".includes(ch) && !(ch === "<" && /\s/.test(mask[i + 1] ?? ""))) depth++;
    else if (")}]".includes(ch) || (ch === ">" && mask[i - 1] !== "=" && depth > 0)) depth--;
    else if (depth === 0 && seps.test(ch)) {
      out.push([start, i]);
      start = i + 1;
    }
  }
  out.push([start, to]);
  return out.filter(([a, b]) => mask.slice(a, b).trim() !== "");
}

/** The member names of an object type or literal body `{ ... }` starting at `open`. */
function membersOf(mask: string, open: number): string[] {
  const end = close(mask, open) - 1;
  return splitTop(mask, open + 1, end, /[;,\n]/)
    .map(
      ([a, b]) =>
        /^\s*(?:readonly\s+)?["']?([A-Za-z_$][\w$-]*)["']?\s*\??\s*[:(]/.exec(
          mask.slice(a, b),
        )?.[1],
    )
    .filter((n): n is string => !!n);
}

/** One parsed file: exported functions and instances, types, classes, constants. */
interface Parsed {
  path: string;
  code: string;
  mask: string;
  shapes: Map<string, string[]>;
  functions: { name: string; params: [number, number] }[];
  classes: Map<string, { name: string; params: [number, number] }[]>;
  objects: Map<string, { name: string; params: [number, number] }[]>;
  instances: Map<string, string>;
  constants: Map<string, string>;
}

function parseFile(path: string, text: string): Parsed {
  const { code, mask } = blank(text.replace(/\r\n/g, "\n"));
  const p: Parsed = {
    path,
    code,
    mask,
    shapes: new Map(),
    functions: [],
    classes: new Map(),
    objects: new Map(),
    instances: new Map(),
    constants: new Map(),
  };
  /** After a name at `i`: skip generics, then the parameter list's range if a `(` follows. */
  const paramsAt = (i: number): [number, number] | undefined => {
    while (/\s/.test(mask[i] ?? "")) i++;
    if (mask[i] === "<") i = close(mask, i);
    while (/\s/.test(mask[i] ?? "")) i++;
    return mask[i] === "(" ? [i + 1, close(mask, i) - 1] : undefined;
  };
  /** Methods at the top level of a class or object body starting at `open`. */
  const methodsIn = (open: number) => {
    const out: { name: string; params: [number, number] }[] = [];
    const end = close(mask, open) - 1;
    for (const [a, b] of splitTop(mask, open + 1, end, /[;,\n}]/)) {
      const seg = mask.slice(a, b);
      const m =
        /^\s*((?:public|static|async|declare|override|abstract|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?=[<(])/.exec(
          seg,
        ) ?? /^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function\s*)?(?=[<(])/.exec(seg);
      if (!m) continue;
      const name = m[2] ?? m[1]!;
      if (/^(private|protected|constructor)$/.test(name) || /^\s*(private|protected)\b/.test(seg))
        continue;
      if (name.startsWith("_") || name.startsWith("#")) continue;
      const params = paramsAt(a + m[0].length);
      if (params) out.push({ name, params });
    }
    return out;
  };

  for (const m of mask.matchAll(/\b(?:interface|type)\s+([A-Za-z_$][\w$]*)\s*(<)?/g)) {
    let i = m.index + m[0].length - (m[2] ? 1 : 0);
    if (mask[i] === "<") i = close(mask, i);
    const brace = mask.indexOf("{", i);
    const between = mask.slice(i, brace);
    if (brace >= 0 && /^\s*(extends[^{]*|=\s*)?$/.test(between))
      p.shapes.set(m[1]!, membersOf(mask, brace));
  }
  for (const m of mask.matchAll(
    /\bexport\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
  )) {
    const params = paramsAt(m.index + m[0].length);
    if (params) p.functions.push({ name: m[1]!, params });
  }
  for (const m of mask.matchAll(
    /\bexport\s+(?:declare\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*)\s*)?(=\s*)?/g,
  )) {
    const name = m[1]!;
    let i = m.index + m[0].length;
    if (m[2] && !m[3]) {
      // export declare const lantern: LanternClient;  (or an inline type: see below)
      p.instances.set(name, m[2]);
      continue;
    }
    if (!m[3]) {
      // export declare const Services: { readonly BFF: "web-bff"; ... };
      const colon = mask.indexOf(":", m.index + m[0].length - 1);
      const brace = mask.indexOf("{", colon);
      if (colon >= 0 && brace >= 0 && mask.slice(colon + 1, brace).trim() === "") {
        const end = close(mask, brace) - 1;
        for (const [a, b] of splitTop(mask, brace + 1, end, /[;,\n]/)) {
          const v = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*:\s*["'`]([^"'`]*)["'`]\s*$/.exec(
            code.slice(a, b),
          );
          if (v) p.constants.set(`${name}.${v[1]!}`, v[2]!);
        }
      }
      continue;
    }
    const rest = code.slice(i);
    const neu = /^new\s+([A-Za-z_$][\w$]*)/.exec(rest);
    if (neu) {
      p.instances.set(name, neu[1]!);
      continue;
    }
    const str = /^["'`]([^"'`$]*)["'`]/.exec(rest);
    if (str) {
      p.constants.set(name, str[1]!);
      continue;
    }
    const arrow = /^(?:async\s*)?(?:function\s*)?(?=[<(])/.exec(rest);
    if (arrow) {
      const params = paramsAt(i + arrow[0].length);
      if (params) p.functions.push({ name, params });
      continue;
    }
    while (/\s/.test(mask[i] ?? "")) i++;
    if (mask[i] === "{") {
      const end = close(mask, i) - 1;
      for (const [a, b] of splitTop(mask, i + 1, end, /[,\n]/)) {
        const v = /^\s*["']?([A-Za-z_$][\w$-]*)["']?\s*:\s*["'`]([^"'`$]*)["'`]\s*$/.exec(
          code.slice(a, b),
        );
        if (v) p.constants.set(`${name}.${v[1]!}`, v[2]!);
      }
      const methods = methodsIn(i);
      if (methods.length) p.objects.set(name, methods);
    }
  }
  for (const m of mask.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)[^{;]*\{/g))
    p.classes.set(m[1]!, methodsIn(m.index + m[0].length - 1));
  return p;
}

/** Each parameter as slots: a name for a positional one, or one per property of an object. */
function slotsOf(p: Parsed, shapes: Map<string, string[]>, range: [number, number]): Slot[] {
  const out: Slot[] = [];
  splitTop(p.mask, range[0], range[1], /,/).forEach(([a, b], arg) => {
    const seg = p.mask.slice(a, b).trim();
    if (seg.startsWith("...")) return;
    if (seg.startsWith("{")) {
      const open = a + p.mask.slice(a, b).indexOf("{");
      const keys = new Set<string>();
      for (const [x, y] of splitTop(p.mask, open + 1, close(p.mask, open) - 1, /,/)) {
        const k = /^\s*([A-Za-z_$][\w$]*)/.exec(p.mask.slice(x, y))?.[1];
        if (k) keys.add(k);
      }
      for (const k of keys) out.push({ name: k, part: { arg, key: k } });
      return;
    }
    const m = /^([A-Za-z_$][\w$]*)\s*\??\s*(?::\s*([\s\S]*))?$/.exec(seg.replace(/=[\s\S]*$/, ""));
    if (!m) return;
    const type = (m[2] ?? "").trim();
    let keys: string[] | undefined;
    if (type.startsWith("{")) keys = membersOf(p.mask, a + p.mask.slice(a, b).indexOf("{"));
    else {
      const named = /^(?:Readonly<|Partial<)?([A-Za-z_$][\w$]*)/.exec(type)?.[1];
      if (named && shapes.has(named)) keys = shapes.get(named);
    }
    if (keys?.length) for (const k of keys) out.push({ name: k, part: { arg, key: k } });
    else out.push({ name: m[1]!, part: { arg } });
  });
  return out;
}

type Entry =
  | { list: "calls"; entry: FrameworkModel["calls"][number] }
  | { list: "routes"; entry: FrameworkModel["routes"][number] };

/** What a function is, from its name and its parameters' names. */
function classify(
  fn: string,
  slots: Slot[],
  receiver: string | undefined,
  source: FrameworkSource,
): Entry | undefined {
  const role = (re: RegExp) => slots.find((s) => re.test(s.name))?.part;
  const base = { function: fn, ...(receiver ? { receiver } : {}), language: "js" as const, source };
  const topic = slots.find((s) => ROLE.topic.test(s.name));
  if (topic) {
    const queue = /^queue$/i.test(topic.name);
    const kind = PUBLISH.test(fn)
      ? queue
        ? "mq-publish"
        : "event-publish"
      : SUBSCRIBE.test(fn)
        ? queue
          ? "mq-subscribe"
          : "event-subscribe"
        : undefined;
    return kind ? { list: "calls", entry: { ...base, kind, path: topic.part } } : undefined;
  }
  const path = role(ROLE.path);
  if (!path) return undefined;
  const verb = VERB.exec(fn)?.[1];
  const method: Part | undefined =
    role(ROLE.method) ?? (verb ? { value: verb.toUpperCase() } : undefined);
  if (!method) return undefined;
  if (role(ROLE.handler)) return { list: "routes", entry: { ...base, httpMethod: method, path } };
  const service = role(ROLE.service);
  return {
    list: "calls",
    entry: {
      ...base,
      kind: "http-call",
      httpMethod: method,
      ...(service ? { service } : {}),
      path,
    },
  };
}

/** Learn from files already read: package.json names, then the code and typings. */
function learnFromFiles(
  files: Map<string, string>,
  o: { name: string; packages?: string[] },
  ref: (path: string) => string,
): { model: FrameworkModel; notes: string[] } {
  const packages = new Set<string>();
  for (const [path, text] of files)
    if (/(^|\/)package\.json$/.test(path) && !SKIP.test(path)) {
      try {
        const n = (JSON.parse(text) as { name?: unknown }).name;
        if (typeof n === "string" && n) packages.add(n);
      } catch {
        // not JSON: not a package
      }
    }
  // Source before typings, so an entry cites the source when both are there.
  const order = [...files.keys()]
    .filter((p) => !/package\.json$/.test(p) && !SKIP.test(p))
    .sort((a, b) => Number(a.endsWith(".d.ts")) - Number(b.endsWith(".d.ts")) || (a < b ? -1 : 1));
  const parsed = order.map((p) => parseFile(p, files.get(p)!));
  const shapes = new Map<string, string[]>();
  const classes = new Map<
    string,
    { file: Parsed; methods: { name: string; params: [number, number] }[] }
  >();
  for (const f of parsed) {
    for (const [k, v] of f.shapes) if (!shapes.has(k)) shapes.set(k, v);
    for (const [k, v] of f.classes) if (!classes.has(k)) classes.set(k, { file: f, methods: v });
  }
  const seen = new Set<string>();
  const calls: FrameworkModel["calls"] = [];
  const routes: FrameworkModel["routes"] = [];
  const constants: FrameworkModel["constants"] = {};
  const add = (e: Entry | undefined) => {
    if (!e) return;
    const key = `${e.entry.function}|${e.entry.receiver ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (e.list === "calls") calls.push(e.entry);
    else routes.push(e.entry);
  };
  for (const f of parsed) {
    const src: FrameworkSource = { kind: "code", ref: ref(f.path) };
    for (const fn of f.functions)
      add(classify(fn.name, slotsOf(f, shapes, fn.params), undefined, src));
    for (const [obj, methods] of f.objects)
      for (const m of methods) add(classify(m.name, slotsOf(f, shapes, m.params), obj, src));
    for (const [inst, cls] of f.instances) {
      const c = classes.get(cls);
      if (!c) continue;
      const csrc: FrameworkSource = { kind: "code", ref: ref(c.file.path) };
      for (const m of c.methods)
        add(classify(m.name, slotsOf(c.file, shapes, m.params), inst, csrc));
    }
    for (const [k, v] of f.constants)
      if (!(k in constants)) constants[k] = { value: v, source: src };
  }
  const byFn = (
    a: { function: string; receiver?: string },
    b: { function: string; receiver?: string },
  ) => (`${a.function}|${a.receiver ?? ""}` < `${b.function}|${b.receiver ?? ""}` ? -1 : 1);
  const serviceIds = Object.keys(constants)
    .filter((k) => /service/i.test(k.split(".")[0]!))
    .sort();
  const notes = serviceIds.length
    ? [
        `${serviceIds.join(", ")} look like service ids: their base URLs aren't in the code; add them under services: (from the registry's config or a person).`,
      ]
    : [];
  const pk = o.packages ?? [...packages].sort();
  if (pk.length === 0)
    throw new Error("no package.json names the framework's package; give it with --package");
  const model = FrameworkModel.parse({
    schemaVersion: 1,
    name: o.name,
    packages: pk,
    calls: calls.sort(byFn),
    routes: routes.sort(byFn),
    constants: Object.fromEntries(Object.entries(constants).sort(([a], [b]) => (a < b ? -1 : 1))),
  });
  return { model, notes };
}

/** From a JS or TS framework's source repo. */
export async function learnJsFramework(
  repo: RepoHandle,
  o: { name: string; packages?: string[] },
): Promise<{ model: FrameworkModel; notes: string[] }> {
  const files = new Map<string, string>();
  for await (const p of repo.listFiles([...FILES, "**/package.json"]))
    if (!SKIP.test(p)) files.set(p, await repo.readText(p));
  // With source there, its compiled output adds nothing.
  const hasSource = [...files.keys()].some((p) => /\.[cm]?tsx?$/.test(p) && !p.endsWith(".d.ts"));
  if (hasSource)
    for (const p of [...files.keys()])
      if (/(^|\/)(dist|build|lib|out)\//.test(p) && !p.endsWith("package.json")) files.delete(p);
  return learnFromFiles(files, o, (p) => `${repo.name}:${p}`);
}

/** From a published package (.tgz): its package.json and typings, else its JavaScript. */
export function learnJsFrameworkFromTarball(
  bytes: Uint8Array,
  o: { name: string; packages?: string[]; tarballName: string },
): { model: FrameworkModel; notes: string[] } {
  const sha = createHash("sha256").update(bytes).digest("hex");
  const tar = readTarGz(bytes);
  const files = new Map<string, string>();
  const wanted = tar.names.filter((n) => /\.(d\.[cm]?ts|[cm]?js)$|(^|\/)package\.json$/.test(n));
  const typings = wanted.some((n) => /\.d\.[cm]?ts$/.test(n));
  for (const n of wanted) if (!typings || !/\.[cm]?js$/.test(n)) files.set(n, tar.text(n) ?? "");
  return learnFromFiles(files, o, (p) => `${o.tarballName}!${p} sha256:${sha}`);
}
