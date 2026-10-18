import { readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node } from "yaml";
import {
  interfaceId,
  matchType,
  normalizePath,
  renderTemplate,
  type CatalogRecord,
  type Dialect,
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
}

const simple = (name: string) => name.split(".").pop()!;

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
): { value: unknown; node: Node | undefined; line: number }[] {
  const tokens = path
    .replace(/^\$/, "")
    .split(/(?=\.\.)|\.(?!\.)|(?=\[)/)
    .filter(Boolean);
  let current: { value: unknown; node: Node | undefined }[] = [{ value: doc, node: doc as Node }];
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
  for (const raw of tokens) {
    const next: { value: unknown; node: Node | undefined }[] = [];
    if (raw.startsWith("..")) {
      const key = raw.slice(2);
      for (const c of current)
        for (const d of [c.node, ...descend(c.node)])
          for (const ch of children(d))
            if (ch.key === key) next.push({ value: toJs(ch.node), node: ch.node });
    } else if (raw.startsWith("[")) {
      const inner = raw.slice(1, -1);
      for (const c of current) {
        const ch = children(c.node);
        for (const x of inner === "*" ? ch : ch.filter((k) => k.key === inner.replace(/['"]/g, "")))
          next.push({ value: toJs(x.node), node: x.node });
      }
    } else {
      for (const c of current)
        for (const ch of children(c.node))
          if (raw === "*" || ch.key === raw) next.push({ value: toJs(ch.node), node: ch.node });
    }
    current = next;
  }
  return current.map((c) => ({ ...c, line: c.node?.range ? lc.linePos(c.node.range[0]).line : 1 }));
}

async function places(repo: RepoHandle, rule: DialectRule): Promise<Place[]> {
  const m = rule.match;
  const out: Place[] = [];
  const type = matchType(m);
  const javaCache = new Map<string, JavaFile>();
  const java = async (p: string) => {
    if (!javaCache.has(p)) javaCache.set(p, parseJava(await repo.readText(p)));
    return javaCache.get(p)!;
  };
  for await (const path of repo.listFiles(m.files)) {
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
      for (const c of (await java(path)).calls) {
        if (c.method !== name || (recv && c.receiver !== recv)) continue;
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
      for (const el of xpath(root, m.xpath))
        out.push({
          path,
          line: el.line,
          attrs: el.attrs,
          typeAnnotations: [],
          match: [el.text.trim()],
        });
    } else if (type === "jsonPath" && "jsonPath" in m) {
      const lc = new LineCounter();
      const doc = parseDocument(await repo.readText(path), { lineCounter: lc });
      for (const hit of jsonPath(doc.contents, m.jsonPath, lc)) {
        const attrs: Record<string, string> = {};
        if (hit.value && typeof hit.value === "object" && !Array.isArray(hit.value)) {
          for (const [k, v] of Object.entries(hit.value as Record<string, unknown>))
            if (v !== null && typeof v !== "object") attrs[k] = String(v);
        }
        out.push({
          path,
          line: hit.line,
          attrs,
          typeAnnotations: [],
          match: [typeof hit.value === "object" ? "" : String(hit.value)],
        });
      }
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
      .map((e) => ({ ...e, text: e.attrs[attrStep[1]!]! }));
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

      for (const rule of [...rules.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        for (const place of await places(repo, rule)) {
          // Pre-resolve yaml:file#key values the templates need (async), then render synchronously.
          const templates = [
            rule.emit.id ?? "",
            ...Object.values(rule.emit.fields).flatMap((v) =>
              typeof v === "string" ? [v] : Array.isArray(v) ? v : [],
            ),
          ];
          const yamlValues = new Map<string, string | undefined>();
          for (const t of templates) {
            for (const m of t.matchAll(/\$\{\s*yaml:([^#}]+)#([^}|\s]+)/g))
              yamlValues.set(`${m[1]}#${m[2]}`, await yamlKey(m[1]!, m[2]!));
          }
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
                return repo.name;
              case "match":
                return place.match[s.group];
              default:
                return undefined;
            }
          };
          const render = (t: string) => renderTemplate(t, resolveSource);
          const fields: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(rule.emit.fields)) {
            if (typeof v === "number" || typeof v === "boolean") fields[k] = v;
            else if (Array.isArray(v))
              fields[k] = v.map(render).filter((x): x is string => x !== undefined && x !== "");
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
          if (rule.emit.kind === "Interface") {
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
            id = render(rule.emit.id!);
          }
          if (!id) {
            ctx.warn(`rule ${rule.id}: the id template could not be filled`, place.path);
            continue;
          }
          yield {
            schemaVersion: 1,
            kind: rule.emit.kind,
            id,
            status: "current",
            confidence: rule.confidence,
            ...fields,
            evidence: [
              {
                source: rule.emit.evidence.source,
                repo: repo.name,
                path: place.path,
                line: place.line,
                dialect: tag,
                ...(rule.emit.evidence.side ? { side: rule.emit.evidence.side } : {}),
              },
            ],
          } as unknown as CatalogRecord;
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
  const extractor = dialectExtractor(dialect, parents);
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
  return failures;
}

/** Find dialect files in an org pack (relative paths for messages). */
export async function listDialectFiles(orgPack: string): Promise<string[]> {
  const dir = join(orgPack, "dialects");
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((n) => /\.ya?ml$/.test(n)).map((n) => relative(orgPack, join(dir, n)));
}
