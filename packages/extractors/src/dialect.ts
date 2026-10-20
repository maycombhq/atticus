import { readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseAllDocuments,
  type Node,
} from "yaml";
import {
  interfaceId,
  matchType,
  normalizePath,
  RECORD_SCHEMAS,
  fieldTemplates,
  renderExpr,
  renderTemplate,
  type CatalogRecord,
  type Dialect,
  type DialectEmit,
  type DialectFieldValue,
  type DialectRule,
  type TemplateSource,
} from "@maycombhq/core";
import {
  defineExtractor,
  fsRepo,
  memoryRepo,
  scanRepo,
  type Extractor,
  type RepoHandle,
  type ScanContext,
} from "@maycombhq/sdk";
import { flattenProperties, flattenYaml, relaxedKey, type ConfigValue } from "./lang/config.js";
import { parseJava, type Annotation, type Decl, type JavaFile } from "./lang/java.js";
import { parseXml, type XmlElement } from "./lang/xml.js";
import { querySyntax, syntaxLanguageOf } from "./lang/syntax.js";
import { componentOf } from "./facts.js";
import { isRef, parseHcl, type HclBlock, type HclValue } from "./platform/hcl.js";
import { loadTerraform, resolve as tfResolve, type TfModule } from "./platform/terraform.js";
import { dirOf } from "./platform/util.js";

/** An HCL value as a template value: plain values only, and nothing still holding ${...}. */
function hclString(v: HclValue | undefined): string | undefined {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return v.includes("${") ? undefined : v;
  return undefined;
}

/**
 * The C2 dialect rule engine: turns a dialect file into an extractor. Each rule's match
 * finds places in the repo; its emit renders a record with the template values each place
 * supplies. Deterministic: same files, same records.
 */

interface Place {
  path: string;
  line: number;
  attrs: Record<string, string>;
  member?: string;
  className?: string;
  /** Annotations on the enclosing type (or the type itself for class-level matches). */
  typeAnnotations: Annotation[];
  match: string[];
  /** A jsonPath match's node as plain data, for collecting list items (ADR 0061). */
  value?: unknown;
  /** A syntax match's captures (ADR 0060). */
  captures?: Record<string, string>;
  /** Around a jsonPath, xpath or hclBlock match (ADR 0058): its key, and the objects above it. */
  node?: { key: string; ups: { key: string; fields: Record<string, string> }[] };
}

/** An object's plain (non-object) fields as text. */
/** An object's plain fields as text; a nested object's are dotted (forward.service). */
const plainFields = (v: unknown, prefix = "", out: Record<string, string> = {}) => {
  if (v && typeof v === "object" && !Array.isArray(v))
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === null || x === undefined) continue;
      if (typeof x !== "object") out[`${prefix}${k}`] = String(x);
      else if (!Array.isArray(x)) plainFields(x, `${prefix}${k}.`, out);
    }
  return out;
};

const simple = (name: string) => name.split(".").pop()!;

/** Nodes a relative path (@.a[*].b, @..name) finds under a plain value (ADR 0061). */
function relativePath(root: unknown, path: string): unknown[] {
  // Tokens: ..key (at any depth), .key, [*], [N] or ['key'].
  const tokens: string[] = [];
  const rest = path.replace(/^@/, "");
  for (let j = 0; j < rest.length;) {
    if (rest.startsWith("..", j) || rest[j] === ".") {
      const deepKey = rest.startsWith("..", j);
      let k = j + (deepKey ? 2 : 1);
      while (k < rest.length && rest[k] !== "." && rest[k] !== "[") k++;
      tokens.push(deepKey ? rest.slice(j, k) : rest.slice(j + 1, k));
      j = k;
    } else if (rest[j] === "[") {
      const k = rest.indexOf("]", j);
      tokens.push(rest.slice(j, k < 0 ? rest.length : k + 1));
      j = k < 0 ? rest.length : k + 1;
    } else j++;
  }
  const kids = (v: unknown): unknown[] =>
    Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : [];
  const deep = (v: unknown): unknown[] => kids(v).flatMap((k) => [k, ...deep(k)]);
  let cur: unknown[] = [root];
  for (const t of tokens) {
    const next: unknown[] = [];
    if (t.startsWith("..")) {
      const key = t.slice(2);
      for (const c of cur)
        for (const d of [c, ...deep(c)])
          if (d && typeof d === "object" && !Array.isArray(d) && key in d)
            next.push((d as Record<string, unknown>)[key]);
    } else if (t.startsWith("[")) {
      const inner = t.slice(1, -1).replace(/['"]/g, "");
      for (const c of cur)
        if (inner === "*") next.push(...kids(c));
        else if (Array.isArray(c) && /^\d+$/.test(inner)) next.push(c[Number(inner)]);
        else if (c && typeof c === "object") next.push((c as Record<string, unknown>)[inner]);
    } else {
      for (const c of cur)
        if (t === "*") next.push(...kids(c));
        else if (c && typeof c === "object" && !Array.isArray(c))
          next.push((c as Record<string, unknown>)[t]);
    }
    cur = next.filter((x) => x !== undefined && x !== null);
  }
  return cur;
}

/** A dotted field of a plain value, as text, or the value itself when name is "". */
function itemValue(v: unknown, name: string): string | undefined {
  let x = v;
  if (name)
    for (const k of name.split(".")) {
      if (!x || typeof x !== "object" || Array.isArray(x)) return undefined;
      x = (x as Record<string, unknown>)[k];
    }
  return x === null || x === undefined || typeof x === "object" ? undefined : String(x);
}

function annAttrs(a: Annotation): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(a.attrs)) out[k] = Array.isArray(v) ? v.join(",") : v;
  return out;
}

function enclosingType(d: Decl): Decl | undefined {
  return d.kind === "method" || d.kind === "field" ? d.parent : d;
}

function globToRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") re += "[^.]*";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Evaluate a small JSONPath subset ($.a.b, $.a[*].b, $.a[0], $..b) over parsed YAML/JSON. */
function jsonPath(
  doc: unknown,
  path: string,
  lc: LineCounter,
): {
  value: unknown;
  node: Node | undefined;
  line: number;
  key: string;
  /** Ancestors, outermost first. */
  anc: { key: string; value: unknown }[];
}[] {
  const tokens = path
    .replace(/^\$/, "")
    .split(/(?=\.\.)|\.(?!\.)|(?=\[)/)
    .filter(Boolean);
  type Hit = {
    value: unknown;
    node: Node | undefined;
    key: string;
    anc: { key: string; value: unknown }[];
  };
  let current: Hit[] = [{ value: doc, node: doc as Node, key: "$", anc: [] }];
  const step = (c: Hit, ch: { key: string; node: Node }): Hit => ({
    value: toJs(ch.node),
    node: ch.node,
    key: ch.key,
    anc: [...c.anc, { key: c.key, value: c.value }],
  });
  const toJs = (n: unknown): unknown =>
    isScalar(n)
      ? n.value
      : n && typeof n === "object" && "toJSON" in (n as object)
        ? (n as { toJSON: () => unknown }).toJSON()
        : n;
  const children = (n: unknown): { key: string; node: Node }[] => {
    if (isMap(n))
      return n.items.map((p) => ({
        key: isScalar(p.key) ? String(p.key.value) : String(p.key),
        node: p.value as Node,
      }));
    if (isSeq(n)) return n.items.map((x, i) => ({ key: String(i), node: x as Node }));
    return [];
  };
  const descend = (n: unknown): Node[] => children(n).flatMap((c) => [c.node, ...descend(c.node)]);
  // The root as plain data, so a match's ancestors include the document's own fields.
  current = [{ ...current[0]!, value: toJs(doc) }];
  for (const raw of tokens) {
    const next: Hit[] = [];
    if (raw.startsWith("..")) {
      // Recursive descent: the ancestors in between aren't kept.
      const key = raw.slice(2);
      for (const c of current)
        for (const d of [c.node, ...descend(c.node)])
          for (const ch of children(d))
            if (ch.key === key)
              next.push({ value: toJs(ch.node), node: ch.node, key: ch.key, anc: [] });
    } else if (raw.startsWith("[")) {
      const inner = raw.slice(1, -1);
      for (const c of current) {
        const ch = children(c.node);
        for (const x of inner === "*" ? ch : ch.filter((k) => k.key === inner.replace(/['"]/g, "")))
          next.push(step(c, x));
      }
    } else {
      for (const c of current)
        for (const ch of children(c.node))
          if (raw === "*" || ch.key === raw) next.push(step(c, ch));
    }
    current = next;
  }
  return current.map((c) => ({ ...c, line: c.node?.range ? lc.linePos(c.node.range[0]).line : 1 }));
}

async function places(
  repo: RepoHandle,
  rule: Pick<DialectRule, "match">,
  ctx: ScanContext,
  terraform: () => Promise<Map<string, TfModule>>,
): Promise<Place[]> {
  const m = rule.match;
  const out: Place[] = [];
  const type = matchType(m);
  const javaCache = new Map<string, JavaFile>();
  const java = async (p: string) => {
    if (!javaCache.has(p)) javaCache.set(p, await parseJava(await repo.readText(p), p));
    return javaCache.get(p)!;
  };
  for await (const path of repo.listFiles(m.files)) {
    // contains (ADR 0062): a file without the text isn't parsed.
    if (m.contains !== undefined) {
      const text = await repo.readText(path);
      const want = Array.isArray(m.contains) ? m.contains : [m.contains];
      if (!want.some((w) => text.includes(w))) continue;
    }
    if (type === "annotation" && "annotation" in m) {
      const want = simple(m.annotation);
      for (const d of (await java(path)).decls) {
        const target = d.kind === "method" ? "method" : d.kind === "field" ? "field" : "class";
        if (m.target !== "any" && m.target !== target) continue;
        for (const a of d.annotations.filter((x) => x.name === want)) {
          const t = enclosingType(d);
          out.push({
            path,
            line: a.line,
            attrs: annAttrs(a),
            ...(d.kind === "method" || d.kind === "field" ? { member: d.name } : {}),
            ...(t ? { className: t.name } : {}),
            typeAnnotations: t?.annotations ?? [],
            match: [],
          });
        }
      }
    } else if (type === "baseClass" && "baseClass" in m) {
      const want = simple(m.baseClass);
      for (const d of (await java(path)).decls) {
        if (d.supertypes.includes(want))
          out.push({
            path,
            line: d.line,
            attrs: {},
            className: d.name,
            typeAnnotations: d.annotations,
            match: [],
          });
      }
    } else if (type === "methodCall" && "methodCall" in m) {
      const [recv, name] = m.methodCall.includes(".")
        ? m.methodCall.split(".")
        : [undefined, m.methodCall];
      // receiverType (ADR 0056): the receiver must be declared with that type, or be the type.
      const types = new Map<string, Set<string>>();
      if (m.receiverType)
        for (const v of (await java(path)).variables)
          types.set(v.name, (types.get(v.name) ?? new Set()).add(v.type));
      const want = m.receiverType ? simple(m.receiverType) : undefined;
      for (const c of (await java(path)).calls) {
        if (c.method !== name || (recv && c.receiver !== recv)) continue;
        if (want) {
          const r = (c.receiver ?? "").replace(/^this\./, "");
          if (r !== want && !types.get(r)?.has(want)) continue;
        }
        const attrs: Record<string, string> = {};
        c.args.forEach((v, i) => v !== undefined && (attrs[`arg${i}`] = v));
        out.push({
          path,
          line: c.line,
          attrs,
          ...(c.inMethod ? { member: c.inMethod.name } : {}),
          ...(c.inType ? { className: c.inType.name } : {}),
          typeAnnotations: c.inType?.annotations ?? [],
          match: [],
        });
      }
    } else if (type === "configKey" && "configKey" in m) {
      const text = await repo.readText(path);
      const flat = path.endsWith(".properties")
        ? flattenProperties(text, path)
        : flattenYaml(text, path);
      const re = globToRe(m.configKey);
      for (const [k, v] of flat) {
        const g = re.exec(k);
        if (g)
          out.push({
            path,
            line: v.line,
            attrs: {},
            typeAnnotations: [],
            match: [v.value, ...k.split(".")],
          });
      }
    } else if (type === "xpath" && "xpath" in m) {
      const root = parseXml(await repo.readText(path));
      const parents = new Map<XmlElement, XmlElement>();
      const index = (e: XmlElement) =>
        e.children.forEach((c) => {
          parents.set(c, e);
          index(c);
        });
      if (root) index(root);
      // An element's fields: its attributes, and the text of its children that have no children.
      const fieldsOf = (e: XmlElement) => {
        const f: Record<string, string> = { ...e.attrs };
        for (const c of e.children)
          if (c.children.length === 0 && !(c.name in f)) f[c.name] = c.text.trim();
        return f;
      };
      for (const el of xpath(root, m.xpath)) {
        const orig = (el as XmlElement & { orig?: XmlElement }).orig ?? el;
        const ups: { key: string; fields: Record<string, string> }[] = [];
        for (let a = parents.get(orig); a; a = parents.get(a))
          ups.push({ key: a.name, fields: fieldsOf(a) });
        out.push({
          path,
          line: el.line,
          attrs: el.attrs,
          typeAnnotations: [],
          match: [el.text.trim()],
          node: { key: orig.name, ups },
        });
      }
    } else if (type === "jsonPath" && "jsonPath" in m) {
      const lc = new LineCounter();
      // Every YAML document in the file (Kubernetes-style files hold several, split by ---).
      const docs = parseAllDocuments(await repo.readText(path), { lineCounter: lc });
      const hits = (Array.isArray(docs) ? docs : [docs]).flatMap((doc) =>
        jsonPath(doc.contents, m.jsonPath, lc),
      );
      for (const hit of hits) {
        const attrs = plainFields(hit.value);
        const value = hit.value;
        out.push({
          path,
          line: hit.line,
          attrs,
          typeAnnotations: [],
          value,
          match: [typeof hit.value === "object" ? "" : String(hit.value)],
          node: {
            key: hit.key,
            // Nearest first; arrays are stepped over, and an object's key is the one it sits under.
            ups: hit.anc
              .map((a, i) => ({ a, i }))
              .filter(({ a }) => a.value && typeof a.value === "object" && !Array.isArray(a.value))
              .map(({ a, i }) => {
                // The key an object sits under: an array index is replaced by the array's key.
                let k = a.key;
                for (let j = i; j > 0 && /^\d+$/.test(k); j--) k = hit.anc[j - 1]!.key;
                return { key: k, fields: plainFields(a.value) };
              })
              .reverse(),
          },
        });
      }
    } else if (type === "hclBlock" && "hclBlock" in m) {
      const [blockType, label] = m.hclBlock.split(".");
      const mod = (await terraform()).get(dirOf(path));
      const hcl = parseHcl(await repo.readText(path));
      const value = (v: HclValue | undefined) => hclString(mod ? tfResolve(mod, v) : v);
      const fieldsOf = (b: HclBlock) => {
        const f: Record<string, string> = {};
        for (const [k, a] of b.attrs) {
          const v = value(isRef(a.value) || typeof a.value !== "object" ? a.value : undefined);
          if (v !== undefined) f[k] = v;
        }
        return f;
      };
      const stack: HclBlock[] = [];
      const visit = (b: HclBlock) => {
        if (b.type === blockType && (!label || b.labels[0] === label)) {
          const attrs: Record<string, string> = {};
          for (const [k, a] of b.attrs) {
            const v = value(isRef(a.value) || typeof a.value !== "object" ? a.value : undefined);
            if (v !== undefined) attrs[k] = v;
          }
          for (const nb of b.blocks)
            for (const [k, a] of nb.attrs) {
              const v = value(a.value);
              if (v !== undefined && !(`${nb.type}.${k}` in attrs)) attrs[`${nb.type}.${k}`] = v;
            }
          out.push({
            path,
            line: b.line,
            attrs,
            typeAnnotations: [],
            match: [b.labels.at(-1) ?? "", ...b.labels],
            node: {
              key: b.labels.at(-1) ?? b.type,
              ups: [...stack]
                .reverse()
                .map((x) => ({ key: x.labels.at(-1) ?? x.type, fields: fieldsOf(x) })),
            },
          });
        }
        stack.push(b);
        b.blocks.forEach(visit);
        stack.pop();
      };
      hcl.blocks.forEach(visit);
      void ctx;
    } else if (type === "syntax" && "syntax" in m) {
      const lang = m.language ?? syntaxLanguageOf(path);
      if (!lang) continue;
      for (const hit of await querySyntax(lang, await repo.readText(path), m.syntax))
        out.push({
          path,
          line: hit.line,
          attrs: {},
          typeAnnotations: [],
          match: [],
          captures: Object.fromEntries(Object.entries(hit.captures).map(([k, v]) => [k, v.value])),
        });
    } else if (type === "regex" && "regex" in m) {
      const text = await repo.readText(path);
      for (const g of text.matchAll(new RegExp(m.regex, "gm"))) {
        out.push({
          path,
          line: text.slice(0, g.index).split("\n").length,
          attrs: {},
          typeAnnotations: [],
          match: [...g].map((x) => x ?? ""),
        });
      }
    }
  }
  return out;
}

/** XPath subset: /a/b, //b, //b[@x='y'], trailing /@attr or /text(). */
function xpath(root: XmlElement | undefined, path: string): XmlElement[] {
  if (!root) return [];
  const steps = path.replace(/\/(text\(\)|@[\w:-]+)$/, "").split("/");
  let current: XmlElement[] = [{ name: "#root", attrs: {}, children: [root], text: "", line: 1 }];
  const all = (e: XmlElement): XmlElement[] => e.children.flatMap((c) => [c, ...all(c)]);
  let deep = false;
  for (const step of steps) {
    if (step === "") {
      deep = true;
      continue;
    }
    const m = /^([\w:*-]+)(?:\[@([\w:-]+)\s*=\s*['"]([^'"]*)['"]\])?$/.exec(step);
    if (!m) return [];
    const name = m[1]!.replace(/^.*:/, "");
    const pool = current.flatMap((c) => (deep ? all(c) : c.children));
    current = pool.filter(
      (e) => (name === "*" || e.name === name) && (!m[2] || e.attrs[m[2]] === m[3]),
    );
    deep = false;
  }
  const attrStep = /\/@([\w:-]+)$/.exec(path);
  if (attrStep)
    return current
      .filter((e) => attrStep[1]! in e.attrs)
      .map((e) => ({ ...e, text: e.attrs[attrStep[1]!]!, orig: e }));
  return current;
}

async function repoConfigFiles(
  repo: RepoHandle,
  globs: readonly string[],
): Promise<Map<string, ConfigValue>> {
  const out = new Map<string, ConfigValue>();
  if (globs.length === 0) return out;
  for await (const f of repo.listFiles(globs)) {
    const text = await repo.readText(f);
    for (const [k, v] of f.endsWith(".properties")
      ? flattenProperties(text, f)
      : flattenYaml(text, f))
      if (!out.has(k)) out.set(k, v);
  }
  return out;
}

/** Turn a dialect into an extractor. `parents` supplies dialects named in `extends`. */
export function dialectExtractor(
  dialect: Dialect,
  parents: Map<string, Dialect> = new Map(),
  o: { emitted?: (ruleId: string) => void } = {},
): Extractor {
  const rules = new Map<string, DialectRule>();
  const visit = (d: Dialect, seen: Set<string>) => {
    for (const p of d.extends) {
      if (seen.has(p)) throw new Error(`dialect ${d.name} extends itself through ${p}`);
      const parent = parents.get(p);
      if (!parent) throw new Error(`dialect ${d.name} extends ${p}, which isn't loaded`);
      visit(parent, new Set([...seen, p]));
    }
    for (const r of d.rules) rules.set(r.id, r);
  };
  visit(dialect, new Set([dialect.name]));
  const claims = [
    ...new Set([...rules.values()].flatMap((r) => r.match.files)),
    ...(dialect.appliesTo.marker ? [dialect.appliesTo.marker] : []),
  ];
  const tag = `${dialect.name}@${dialect.version}`;

  return defineExtractor({
    id: `dialect-${dialect.name}`,
    version: dialect.version,
    claims: claims.length > 0 ? claims : ["**/*"],
    async *scan(repo: RepoHandle, ctx: ScanContext) {
      if (
        dialect.appliesTo.repoTypes.length > 0 &&
        ctx.repoType &&
        !dialect.appliesTo.repoTypes.includes(ctx.repoType) &&
        !dialect.appliesTo.repoTypes.includes("*") &&
        !ctx.dialects.includes(dialect.name)
      )
        return;
      if (dialect.appliesTo.marker) {
        let found = false;
        for await (const _ of repo.listFiles([dialect.appliesTo.marker])) {
          found = true;
          break;
        }
        if (!found) return;
      }
      const config = await repoConfigFiles(repo, dialect.layout.configFiles);
      const relaxed = new Map([...config].map(([k, v]) => [relaxedKey(k), v.value]));
      const yamlCache = new Map<string, Map<string, ConfigValue>>();
      const yamlKey = async (file: string, key: string) => {
        if (!yamlCache.has(file)) {
          const text = await repo.readText(file).catch(() => undefined);
          yamlCache.set(file, text === undefined ? new Map() : flattenYaml(text, file));
        }
        return yamlCache.get(file)!.get(key)?.value;
      };

      let tf: Promise<Map<string, TfModule>> | undefined;
      const terraform = () =>
        (tf ??= loadTerraform(repo, ctx, /./).then((mods) => new Map(mods.map((x) => [x.dir, x]))));

      /** Templates' yaml:file#key values, read ahead so rendering stays synchronous. */
      const yamlFor = async (templates: string[]) => {
        const out = new Map<string, string | undefined>();
        for (const t of templates)
          for (const m of t.matchAll(/\$\{\s*yaml:([^#}]+)#([^}|\s]+)/g))
            out.set(`${m[1]}#${m[2]}`, await yamlKey(m[1]!, m[2]!));
        return out;
      };
      const templatesOf = (e: DialectEmit) => [
        e.id ?? "",
        ...Object.values(e.fields).flatMap(fieldTemplates),
      ];
      /** What a template value is at one place; lookups come from the tables below. */
      const resolverFor = (
        place: Place,
        yamlValues: Map<string, string | undefined>,
        withLookups: boolean,
      ) => {
        const resolveSource = (s: TemplateSource): string | undefined => {
          switch (s.type) {
            case "attr":
              return place.attrs[s.name];
            case "annotation": {
              const a = place.typeAnnotations.find((x) => x.name === s.annotation);
              const v = a?.attrs[s.name];
              return Array.isArray(v) ? v.join(",") : v;
            }
            case "config":
              return config.get(s.key)?.value ?? relaxed.get(relaxedKey(s.key));
            case "yaml":
              return yamlValues.get(`${s.file}#${s.key}`);
            case "member":
              return place.member;
            case "class":
              return place.className;
            case "file":
              return s.name === "path" ? place.path : String(place.line);
            case "repo":
              return s.name === "component" ? componentOf(repo, ctx, place.path) : repo.name;
            case "match":
              return place.match[s.group];
            case "capture":
              return place.captures?.[s.name];
            case "node": {
              if (!place.node) return undefined;
              if (s.up === 0) return place.node.key;
              const up = place.node.ups[s.up - 1];
              return s.name === "key" ? up?.key : up?.fields[s.name];
            }
            case "lookup": {
              if (!withLookups) return undefined;
              const key = renderExpr(s.key, resolveSource);
              const v = key === undefined ? undefined : tables.get(s.table)?.get(key)?.get(s.field);
              return v === null ? undefined : v;
            }
            default:
              return undefined;
          }
        };
        return resolveSource;
      };

      // Lookup tables (ADR 0058): key → value name → value; null where two rows disagree.
      const tables = new Map<string, Map<string, Map<string, string | null>>>();
      for (const [name, l] of Object.entries(dialect.lookups ?? {})) {
        const table = new Map<string, Map<string, string | null>>();
        const yamlValues = await yamlFor([l.key, ...Object.values(l.values)]);
        for (const place of await places(repo, { match: l.match }, ctx, terraform)) {
          const resolve = resolverFor(place, yamlValues, false);
          const key = renderTemplate(l.key, resolve);
          if (key === undefined) continue;
          const row = table.get(key) ?? new Map<string, string | null>();
          for (const [field, t] of Object.entries(l.values)) {
            const v = renderTemplate(t, resolve);
            if (v === undefined) continue;
            const had = row.get(field);
            row.set(field, had === undefined || had === v ? v : null);
          }
          table.set(key, row);
        }
        tables.set(name, table);
      }

      for (const rule of [...rules.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        const emits = Array.isArray(rule.emit) ? rule.emit : [rule.emit];
        const yamlValues = await yamlFor([
          ...emits.flatMap(templatesOf),
          ...(rule.where ?? []).map((w) => w.value),
        ]);
        for (const place of await places(repo, rule, ctx, terraform)) {
          const render = (t: string) => renderTemplate(t, resolverFor(place, yamlValues, true));
          // where (ADR 0056): every condition must hold; a value that can't be filled fails.
          if (
            !(rule.where ?? []).every((w) => {
              const v = render(w.value);
              return v !== undefined && new RegExp(w.matches).test(v);
            })
          )
            continue;
          // Each record the rule emits for this place (ADR 0058), each checked on its own.
          for (const emit of emits) {
            const fields: Record<string, unknown> = {};
            const base = resolverFor(place, yamlValues, true);
            /** A field value rendered: nested objects and collecting items too (ADR 0061). */
            const renderValue = (v: DialectFieldValue): unknown => {
              if (typeof v === "number" || typeof v === "boolean") return v;
              if (typeof v === "string") return render(v);
              if (Array.isArray(v)) {
                const out: string[] = [];
                for (const x of v) {
                  if (typeof x === "string") {
                    const r = render(x);
                    if (r !== undefined && r !== "") out.push(r);
                    continue;
                  }
                  for (const node of relativePath(place.value, x.each)) {
                    const at = (src: TemplateSource) =>
                      src.type === "item" ? itemValue(node, src.name) : base(src);
                    // where on the item (ADR 0062): every condition must hold for this node.
                    if (
                      !(x.where ?? []).every((w) => {
                        const v = renderTemplate(w.value, at);
                        return v !== undefined && new RegExp(w.matches).test(v);
                      })
                    )
                      continue;
                    const r = renderTemplate(x.value, at);
                    if (r !== undefined && r !== "" && !out.includes(r)) out.push(r);
                  }
                }
                return out;
              }
              const obj: Record<string, unknown> = {};
              for (const [k, x] of Object.entries(v)) {
                const r = renderValue(x);
                if (r !== undefined) obj[k] = r;
              }
              return obj;
            };
            for (const [k, v] of Object.entries(emit.fields)) {
              if (typeof v === "number" || typeof v === "boolean") fields[k] = v;
              else if (Array.isArray(v) || typeof v === "object") fields[k] = renderValue(v);
              else {
                let r = render(v);
                if (r !== undefined && (k === "normalizedPath" || k === "pathOrTopic")) {
                  for (const p of dialect.normalize.stripPathPrefixes)
                    if (r.startsWith(p)) r = r.slice(p.length) || "/";
                }
                if (r !== undefined) fields[k] = r;
              }
            }
            let id: string | undefined;
            if (emit.kind === "Interface") {
              if (
                typeof fields.from !== "string" ||
                typeof fields.to !== "string" ||
                typeof fields.normalizedPath !== "string"
              ) {
                ctx.warn(
                  `rule ${rule.id}: from, to or normalizedPath could not be filled`,
                  place.path,
                );
                continue;
              }
              fields.normalizedPath = normalizePath(fields.normalizedPath);
              id = interfaceId(
                fields.from,
                fields.to,
                fields.method as string | undefined,
                fields.normalizedPath as string,
              );
            } else {
              id = render(emit.id!);
            }
            if (!id) {
              ctx.warn(`rule ${rule.id}: the id template could not be filled`, place.path);
              continue;
            }
            // A field C1 requires that the rule sets but couldn't fill: skip with a warning (ADR 0056).
            const shape = (
              RECORD_SCHEMAS[emit.kind] as unknown as {
                shape: Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
              }
            ).shape;
            const unfilled = Object.keys(emit.fields).filter(
              (k) => fields[k] === undefined && shape[k] && !shape[k].safeParse(undefined).success,
            );
            if (unfilled.length > 0) {
              ctx.warn(
                `rule ${rule.id}: ${unfilled.join(", ")} could not be filled, so ${id} isn't emitted`,
                place.path,
              );
              continue;
            }
            o.emitted?.(rule.id);
            yield {
              schemaVersion: 1,
              kind: emit.kind,
              id,
              status: "current",
              confidence: rule.confidence,
              ...fields,
              evidence: [
                {
                  source: emit.evidence.source,
                  repo: repo.name,
                  path: place.path,
                  line: place.line,
                  dialect: tag,
                  ...(emit.evidence.side ? { side: emit.evidence.side } : {}),
                },
              ],
            } as unknown as CatalogRecord;
          }
        }
      }
    },
  });
}

export interface DialectTestFailure {
  test: string;
  message: string;
}

/** Run a dialect's own tests. A dialect whose tests fail must not load. */
export async function runDialectTests(
  dialect: Dialect,
  dialectDir: string,
  parents: Map<string, Dialect> = new Map(),
): Promise<DialectTestFailure[]> {
  const failures: DialectTestFailure[] = [];
  const emitted = new Set<string>();
  const extractor = dialectExtractor(dialect, parents, { emitted: (id) => emitted.add(id) });
  for (const t of dialect.tests) {
    let repo: RepoHandle;
    if (t.files) repo = memoryRepo("dialect-test", "0".repeat(40), t.files);
    else {
      const dir = resolve(dialectDir, t.fixture!);
      repo = fsRepo(dir.split(sep).pop() ?? "fixture", dir, "0".repeat(40));
    }
    const result = await scanRepo({
      repo,
      extractors: [extractor],
      dialects: [dialect.name],
      scannedAt: "2026-01-01T00:00:00Z",
    });
    for (const r of result.rejected)
      failures.push({
        test: t.name,
        message: `produced an invalid record: ${r.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      });
    for (const run of result.runs.filter((x) => x.status === "failed"))
      failures.push({ test: t.name, message: `failed: ${run.error}` });
    const byId = new Map(
      result.records.map((r) => [r.id, r as unknown as Record<string, unknown>]),
    );
    for (const want of t.expect) {
      const got = byId.get(want.id);
      if (!got) {
        failures.push({
          test: t.name,
          message: `expected ${want.kind} ${want.id}, got ${[...byId.keys()].join(", ") || "nothing"}`,
        });
        continue;
      }
      for (const [k, v] of Object.entries(want)) {
        if (JSON.stringify(got[k]) !== JSON.stringify(v))
          failures.push({
            test: t.name,
            message: `${want.id}.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got[k])}`,
          });
      }
    }
    if (t.expect.length === 0 && t.files && result.records.length > 0) {
      failures.push({
        test: t.name,
        message: `expected no records, got ${result.records.map((r) => r.id).join(", ")}`,
      });
    }
    for (const id of t.absent)
      if (byId.has(id)) failures.push({ test: t.name, message: `${id} should not be produced` });
  }
  // Every rule of the dialect's own must produce something in some test (ADR 0056).
  for (const r of dialect.rules)
    if (!emitted.has(r.id))
      failures.push({ test: "(coverage)", message: `rule ${r.id} produces nothing in any test` });
  return failures;
}

/** Find dialect files in an org pack (relative paths for messages). */
export async function listDialectFiles(orgPack: string): Promise<string[]> {
  const dir = join(orgPack, "dialects");
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((n) => /\.ya?ml$/.test(n)).map((n) => relative(orgPack, join(dir, n)));
}
