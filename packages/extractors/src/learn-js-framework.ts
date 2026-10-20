import { createHash } from "node:crypto";
import { FrameworkModel, readTarGz, type FrameworkSource } from "@maycombhq/core";
import type { RepoHandle } from "@maycombhq/sdk";
import type Parser from "web-tree-sitter";
import { parseSyntax, syntaxLanguageOf } from "./lang/syntax.js";

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
 * And exported objects' string constants, as Object.KEY. Every entry's source is `code`, with
 * the file (and the tarball and its checksum). What neither can say, a service id's base URL,
 * is returned in `notes`. Files are read from their syntax trees (ADR 0060), .d.ts typings
 * with the TypeScript grammar.
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

type Node = Parser.SyntaxNode;

const kids = (n: Node | null | undefined): Node[] =>
  (n?.namedChildren ?? []).filter((c) => c.type !== "comment");

/** One parameter, as read from the tree: the type it names is resolved once every file is read. */
type Param =
  | { kind: "skip" }
  | { kind: "keys"; keys: string[] }
  | { kind: "name"; name: string; keys?: string[]; typeName?: string };

interface Fn {
  name: string;
  params: Param[];
}

/** One parsed file: exported functions and instances, types, classes, constants. */
interface Parsed {
  path: string;
  shapes: Map<string, string[]>;
  functions: Fn[];
  classes: Map<string, Fn[]>;
  objects: Map<string, Fn[]>;
  instances: Map<string, string>;
  constants: Map<string, string>;
}

/** A property's or member's name: an identifier, or a quoted string's contents. */
function nameOf(n: Node | null | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === "string") return n.text.slice(1, -1);
  if (/identifier$/.test(n.type)) return n.text;
  return undefined;
}

/** A string literal's contents as written (no template substitutions), else undefined. */
function stringValue(n: Node | null | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === "string") return n.text.slice(1, -1);
  if (n.type === "template_string" && !kids(n).some((c) => c.type === "template_substitution"))
    return n.text.slice(1, -1);
  return undefined;
}

/** `x as const`, `x satisfies T`, `x!`: the expression inside. */
function unwrap(n: Node | null | undefined): Node | null | undefined {
  while (
    n &&
    (n.type === "as_expression" ||
      n.type === "satisfies_expression" ||
      n.type === "non_null_expression")
  )
    n = kids(n)[0];
  return n;
}

/** The member names of an object type or interface body. */
function membersOf(body: Node): string[] {
  return kids(body)
    .filter((m) => m.type === "property_signature" || m.type === "method_signature")
    .map((m) => nameOf(m.childForFieldName("name")))
    .filter((n): n is string => !!n);
}

/** The type a type annotation names, to look up as a shape: `Readonly<X>` and `Partial<X>` name X. */
function typeNameOf(t: Node | undefined): string | undefined {
  if (!t) return undefined;
  if (t.type === "type_identifier") return t.text;
  if (t.type === "generic_type") {
    const name = t.childForFieldName("name")?.text;
    const arg = kids(kids(t).find((c) => c.type === "type_arguments"))[0];
    if ((name === "Readonly" || name === "Partial") && arg) return typeNameOf(arg) ?? name;
    return name;
  }
  return undefined;
}

/** A parameter list as parameters: positional names, or the keys of a destructured object. */
function paramsOf(list: Node | null | undefined): Param[] | undefined {
  if (!list) return undefined;
  // An arrow function's single bare parameter: `path => ...`.
  if (list.type === "identifier") return [{ kind: "name", name: list.text }];
  if (list.type !== "formal_parameters") return undefined;
  return kids(list).map((p): Param => {
    const typed = p.type === "required_parameter" || p.type === "optional_parameter";
    let pattern: Node | null | undefined = typed ? p.childForFieldName("pattern") : p;
    if (pattern?.type === "assignment_pattern") pattern = pattern.childForFieldName("left");
    const type = typed ? kids(p.childForFieldName("type"))[0] : undefined;
    if (!pattern || pattern.type === "rest_pattern") return { kind: "skip" };
    if (pattern.type === "object_pattern") {
      const keys = new Set<string>();
      for (const k of kids(pattern)) {
        const key =
          k.type === "shorthand_property_identifier_pattern"
            ? k.text
            : k.type === "pair_pattern"
              ? nameOf(k.childForFieldName("key"))
              : k.type === "object_assignment_pattern"
                ? k.childForFieldName("left")?.text
                : undefined;
        if (key) keys.add(key);
      }
      return { kind: "keys", keys: [...keys] };
    }
    if (pattern.type !== "identifier" && pattern.type !== "this") return { kind: "skip" };
    if (type?.type === "object_type")
      return { kind: "name", name: pattern.text, keys: membersOf(type) };
    const typeName = typeNameOf(type);
    return { kind: "name", name: pattern.text, ...(typeName ? { typeName } : {}) };
  });
}

const FUNCTION_VALUES = new Set([
  "arrow_function",
  "function",
  "function_expression",
  "generator_function",
]);

/** A function-valued node's parameters: an arrow or function expression, or a function type. */
function functionParams(v: Node | null | undefined): Param[] | undefined {
  if (!v) return undefined;
  if (FUNCTION_VALUES.has(v.type))
    return paramsOf(v.childForFieldName("parameters") ?? v.childForFieldName("parameter"));
  if (v.type === "function_type") return paramsOf(v.childForFieldName("parameters"));
  return undefined;
}

/** The public methods of a class body or object literal (not private, protected, _ or #). */
function methodsIn(body: Node): Fn[] {
  const out: Fn[] = [];
  for (const m of kids(body)) {
    let name: string | undefined;
    let params: Param[] | undefined;
    if (
      m.type === "method_definition" ||
      m.type === "method_signature" ||
      m.type === "abstract_method_signature"
    ) {
      name = nameOf(m.childForFieldName("name"));
      params = paramsOf(m.childForFieldName("parameters"));
    } else if (m.type === "pair") {
      name = nameOf(m.childForFieldName("key"));
      params = functionParams(m.childForFieldName("value"));
    } else if (m.type === "public_field_definition" || m.type === "property_signature") {
      name = nameOf(m.childForFieldName("name"));
      params = functionParams(kids(m.childForFieldName("type"))[0]);
    }
    if (!name || !params) continue;
    const access = kids(m).find((c) => c.type === "accessibility_modifier")?.text;
    if (access === "private" || access === "protected" || name === "constructor") continue;
    if (name.startsWith("_") || name.startsWith("#")) continue;
    out.push({ name, params });
  }
  return out;
}

/** Constants an object literal (`{ BFF: "web-bff" }`) or object type (`{ readonly BFF: "web-bff" }`) holds. */
function constantsIn(body: Node, owner: string, into: Map<string, string>) {
  for (const m of kids(body)) {
    let key: string | undefined;
    let v: string | undefined;
    if (m.type === "pair") {
      key = nameOf(m.childForFieldName("key"));
      v = stringValue(m.childForFieldName("value"));
    } else if (m.type === "property_signature") {
      key = nameOf(m.childForFieldName("name"));
      const t = kids(m.childForFieldName("type"))[0];
      if (t?.type === "literal_type") v = stringValue(kids(t)[0]);
    }
    if (key !== undefined && v !== undefined) into.set(`${owner}.${key}`, v);
  }
}

/** A file read from its syntax tree (ADR 0060); comments and strings are never taken for code. */
async function parseFile(path: string, text: string): Promise<Parsed> {
  const p: Parsed = {
    path,
    shapes: new Map(),
    functions: [],
    classes: new Map(),
    objects: new Map(),
    instances: new Map(),
    constants: new Map(),
  };
  const lang = syntaxLanguageOf(path);
  if (!lang) return p;
  const tree = await parseSyntax(lang, text);
  const exported = (d: Node) => {
    if (d.type === "ambient_declaration") {
      for (const c of kids(d)) exported(c);
      return;
    }
    if (
      d.type === "function_declaration" ||
      d.type === "generator_function_declaration" ||
      d.type === "function_signature"
    ) {
      const name = d.childForFieldName("name")?.text;
      const params = paramsOf(d.childForFieldName("parameters"));
      if (name && params) p.functions.push({ name, params });
      return;
    }
    // const and let, not var.
    if (d.type !== "lexical_declaration") return;
    for (const v of kids(d).filter((c) => c.type === "variable_declarator")) {
      const name = v.childForFieldName("name");
      if (name?.type !== "identifier") continue;
      const type = kids(v.childForFieldName("type"))[0];
      const value = unwrap(v.childForFieldName("value"));
      if (!value) {
        // export declare const lantern: LanternClient;  export declare const Services: { ... };
        if (type?.type === "object_type") constantsIn(type, name.text, p.constants);
        else {
          const t =
            type?.type === "generic_type" ? type.childForFieldName("name")?.text : type?.text;
          if (type && t && /^[A-Za-z_$][\w$]*$/.test(t)) p.instances.set(name.text, t);
        }
        continue;
      }
      if (value.type === "new_expression") {
        const cls = value.childForFieldName("constructor");
        if (cls?.type === "identifier") p.instances.set(name.text, cls.text);
        continue;
      }
      // A lone string constant isn't kept: a model's constants are qualified (Object.KEY).
      if (stringValue(value) !== undefined) continue;
      const params = functionParams(value);
      if (params) {
        p.functions.push({ name: name.text, params });
        continue;
      }
      if (value.type === "object") {
        constantsIn(value, name.text, p.constants);
        const methods = methodsIn(value);
        if (methods.length) p.objects.set(name.text, methods);
      }
    }
  };
  const walk = (n: Node) => {
    const t = n.type;
    if (t === "export_statement") {
      const d = n.childForFieldName("declaration");
      if (d) exported(d);
    }
    if (t === "interface_declaration") {
      const name = n.childForFieldName("name")?.text;
      const body = n.childForFieldName("body");
      if (name && body) p.shapes.set(name, membersOf(body));
    }
    if (t === "type_alias_declaration") {
      const name = n.childForFieldName("name")?.text;
      const value = n.childForFieldName("value");
      if (name && value?.type === "object_type") p.shapes.set(name, membersOf(value));
    }
    if (t === "class_declaration" || t === "abstract_class_declaration" || t === "class") {
      const name = n.childForFieldName("name")?.text;
      const body = n.childForFieldName("body");
      if (name && body) p.classes.set(name, methodsIn(body));
    }
    for (const c of kids(n)) walk(c);
  };
  walk(tree.rootNode);
  tree.delete();
  return p;
}

/** Each parameter as slots: a name for a positional one, or one per property of an object. */
function slotsOf(params: Param[], shapes: Map<string, string[]>): Slot[] {
  const out: Slot[] = [];
  params.forEach((prm, arg) => {
    if (prm.kind === "skip") return;
    if (prm.kind === "keys") {
      for (const k of prm.keys) out.push({ name: k, part: { arg, key: k } });
      return;
    }
    const keys = prm.keys ?? (prm.typeName ? shapes.get(prm.typeName) : undefined);
    if (keys?.length) for (const k of keys) out.push({ name: k, part: { arg, key: k } });
    else out.push({ name: prm.name, part: { arg } });
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
async function learnFromFiles(
  files: Map<string, string>,
  o: { name: string; packages?: string[] },
  ref: (path: string) => string,
): Promise<{ model: FrameworkModel; notes: string[] }> {
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
  const parsed: Parsed[] = [];
  for (const p of order) parsed.push(await parseFile(p, files.get(p)!));
  const shapes = new Map<string, string[]>();
  const classes = new Map<string, { file: Parsed; methods: Fn[] }>();
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
      add(classify(fn.name, slotsOf(fn.params, shapes), undefined, src));
    for (const [obj, methods] of f.objects)
      for (const m of methods) add(classify(m.name, slotsOf(m.params, shapes), obj, src));
    for (const [inst, cls] of f.instances) {
      const c = classes.get(cls);
      if (!c) continue;
      const csrc: FrameworkSource = { kind: "code", ref: ref(c.file.path) };
      for (const m of c.methods) add(classify(m.name, slotsOf(m.params, shapes), inst, csrc));
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
export async function learnJsFrameworkFromTarball(
  bytes: Uint8Array,
  o: { name: string; packages?: string[]; tarballName: string },
): Promise<{ model: FrameworkModel; notes: string[] }> {
  const sha = createHash("sha256").update(bytes).digest("hex");
  const tar = readTarGz(bytes);
  const files = new Map<string, string>();
  const wanted = tar.names.filter((n) => /\.(d\.[cm]?ts|[cm]?js)$|(^|\/)package\.json$/.test(n));
  const typings = wanted.some((n) => /\.d\.[cm]?ts$/.test(n));
  for (const n of wanted) if (!typings || !/\.[cm]?js$/.test(n)) files.set(n, tar.text(n) ?? "");
  return learnFromFiles(files, o, (p) => `${o.tarballName}!${p} sha256:${sha}`);
}
