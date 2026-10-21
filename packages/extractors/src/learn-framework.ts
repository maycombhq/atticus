import { createHash } from "node:crypto";
import { FrameworkModel, readZip, type FrameworkSource } from "@maycombhq/core";
import type { RepoHandle } from "@maycombhq/sdk";
import {
  ClassFileError,
  parseClass,
  type ClassAnnotation,
  type ElementValue,
} from "./lang/classfile.js";
import { attr, parseJava } from "./lang/java.js";
import { parseJavaMembers } from "./lang/java-tree.js";
import { at } from "./lang/parsed.js";
import { parseXml, selectText } from "./lang/xml.js";
import { CLIENT_PACKAGES, READ_ANNOTATIONS } from "./spring.js";

/**
 * Learning a framework model (ADR 0054), deterministically, from a house starter's source repo
 * (learnFramework) or from its JAR (learnFrameworkFromJar). Both read the same things:
 *
 * - each annotation type: the annotations it is meta-annotated with that the Spring extractor
 *   reads (or other house annotations, expanded), `@AliasFor` members as the attribute mapping,
 *   and attribute values on a meta-annotation as fixed values (`@Op(verb = "GET")`);
 * - each public method of a class that uses an HTTP client whose parameters name a path
 *   (path, uri, url) and a method (method, verb), or whose name is a verb (get, post): a
 *   wrapper client, with the positions of its service, method and path arguments;
 * - each `static final String` constant, as Class.NAME.
 *
 * Every entry's source is `code` (with the file) or `bytecode` (with the JAR entry and the
 * JAR's checksum). What neither can say (a service id's base URL) is returned in `notes`.
 * Source is read from its syntax tree (ADR 0060) and the pom through the XML reader.
 */

interface House {
  source: FrameworkSource;
  metas: { name: string; attrs: Record<string, string | string[]> }[];
  aliases: Map<string, { annotation?: string; attribute: string }>;
}

interface Collected {
  house: Map<string, House>;
  clients: FrameworkModel["clients"];
  constants: FrameworkModel["constants"];
  packages: Set<string>;
  artifacts: string[];
  serviceIds: string[];
}

const collected = (): Collected => ({
  house: new Map(),
  clients: [],
  constants: {},
  packages: new Set(),
  artifacts: [],
  serviceIds: [],
});

/** Java's own meta-annotations: they say how an annotation works, not what it means. */
const JAVA_META = new Set(["Target", "Retention", "Documented", "Inherited", "Repeatable"]);

/** A wrapper client from a method's name and parameter names, when it reads as one. */
function clientOf(
  type: string,
  method: string,
  names: string[],
  source: FrameworkSource,
): FrameworkModel["clients"][number] | undefined {
  const at = (re: RegExp) => names.findIndex((n) => re.test(n));
  const service = at(/^(service|serviceId|serviceName|target|system)$/i);
  const verb = at(/^(method|verb|httpMethod)$/i);
  const path = at(/^(path|uri|url|endpoint)$/i);
  const byName = /^(get|post|put|delete|patch)/i.exec(method)?.[1]?.toUpperCase();
  if (path < 0 || (verb < 0 && !byName)) return undefined;
  return {
    type,
    method,
    ...(service >= 0 ? { service: { arg: service } } : {}),
    httpMethod: verb >= 0 ? { arg: verb } : { value: byName! },
    path: { arg: path },
    source,
  };
}

function addConstant(
  c: Collected,
  owner: string,
  name: string,
  value: string,
  source: FrameworkSource,
) {
  c.constants[`${owner}.${name}`] = { value, source };
  if (/service/i.test(owner)) c.serviceIds.push(`${owner}.${name}`);
}

/** The model the collected facts make: house-on-house annotations expanded, notes for the gaps. */
function assemble(c: Collected, o: { name: string; packages?: string[] }) {
  const resolve = (
    name: string,
    seen: Set<string>,
  ): { means: string[]; attributes: Record<string, string>; fixed: Record<string, string> } => {
    const h = c.house.get(name)!;
    const means: string[] = [];
    const attributes: Record<string, string> = {};
    const fixed: Record<string, string> = {};
    const one = (v: string | string[]) => String(Array.isArray(v) ? v[0] : v).replace(/^.*\./, "");
    for (const meta of h.metas) {
      if (READ_ANNOTATIONS.has(meta.name)) {
        means.push(meta.name);
        for (const [k, v] of Object.entries(meta.attrs)) fixed[k] = one(v);
      } else if (c.house.has(meta.name) && !seen.has(meta.name)) {
        const inner = resolve(meta.name, new Set([...seen, meta.name]));
        means.push(...inner.means);
        Object.assign(fixed, inner.fixed);
        for (const [k, v] of Object.entries(meta.attrs)) {
          const to = inner.attributes[k];
          if (to) fixed[to] = one(v);
        }
      }
    }
    for (const [member, al] of h.aliases) {
      if (!al.annotation || READ_ANNOTATIONS.has(al.annotation)) attributes[member] = al.attribute;
      else if (c.house.has(al.annotation) && !seen.has(al.annotation)) {
        const to = resolve(al.annotation, new Set([...seen, al.annotation])).attributes[
          al.attribute
        ];
        if (to) attributes[member] = to;
      }
    }
    return { means: [...new Set(means)], attributes, fixed };
  };
  const annotations: FrameworkModel["annotations"] = [];
  for (const name of [...c.house.keys()].sort()) {
    const r = resolve(name, new Set([name]));
    if (r.means.length > 0) annotations.push({ name, ...r, source: c.house.get(name)!.source });
  }
  const notes: string[] = [];
  if (c.serviceIds.length > 0)
    notes.push(
      `${[...new Set(c.serviceIds)].sort().join(", ")} look like service ids: their base URLs aren't in the code; add them under services: (from the registry's config or a person).`,
    );
  const model = FrameworkModel.parse({
    schemaVersion: 1,
    name: o.name,
    packages: o.packages ?? [commonPrefix([...c.packages])].filter(Boolean),
    artifacts: [...new Set(c.artifacts)],
    annotations,
    clients: c.clients,
    services: {},
    constants: Object.fromEntries(Object.entries(c.constants).sort(([a], [b]) => (a < b ? -1 : 1))),
  });
  return { model, notes };
}

/** From a starter's source repo. */
export async function learnFramework(
  repo: RepoHandle,
  o: { name: string; packages?: string[] },
): Promise<{ model: FrameworkModel; notes: string[] }> {
  const src = (path: string): FrameworkSource => ({ kind: "code", ref: `${repo.name}:${path}` });
  const c = collected();
  for await (const path of repo.listFiles(["**/*.java", "**/pom.xml"])) {
    if (/(^|\/)src\/test\//.test(path)) continue;
    const text = await repo.readText(path);
    if (path.endsWith("pom.xml")) {
      if (path === "pom.xml") {
        // The project's own coordinates; a groupId left out is the parent's (Maven inherits it).
        const pom = parseXml(text, at(repo, path));
        const g = selectText(pom, "project/groupId") ?? selectText(pom, "project/parent/groupId");
        const a = selectText(pom, "project/artifactId");
        if (g?.text && a?.text) c.artifacts.push(`${g.text}:${a.text}`);
      }
      continue;
    }
    const file = await parseJava(text, path, repo.parseCache);
    const members = await parseJavaMembers(text, at(repo, path));
    if (file.packageName) c.packages.add(file.packageName);
    for (const d of file.decls.filter((x) => x.kind === "annotation-type")) {
      const aliases = new Map<string, { annotation?: string; attribute: string }>();
      for (const m of members.annotationMembers.filter((x) => x.owner === d.name)) {
        const al = m.annotations.find((a) => a.name === "AliasFor");
        if (!al) continue;
        const annotation = attr(al, "annotation")
          ?.replace(/\.class$/, "")
          .split(".")
          .pop();
        const attribute = attr(al, "attribute") || attr(al) || m.name;
        aliases.set(m.name, { ...(annotation ? { annotation } : {}), attribute });
      }
      c.house.set(d.name, {
        source: src(path),
        metas: d.annotations
          .filter((a) => !JAVA_META.has(a.name))
          .map((a) => ({ name: a.name, attrs: a.attrs })),
        aliases,
      });
    }
    for (const k of file.constants) addConstant(c, k.owner, k.name, k.value, src(path));
    if (!CLIENT_PACKAGES.some((p) => file.imports.some((i) => i.startsWith(p)))) continue;
    for (const m of members.methods) {
      if (m.isConstructor || !m.hasBody || !m.modifiers.includes("public")) continue;
      const cl = clientOf(
        m.owner,
        m.name,
        m.params.map((p) => p.name),
        src(path),
      );
      if (cl) c.clients.push(cl);
    }
  }
  return assemble(c, o);
}

/** An annotation value as an attribute value: text, or a list of texts. */
const attrValue = (v: ElementValue): string | string[] =>
  Array.isArray(v)
    ? v.map((x) => (typeof x === "string" ? x : ""))
    : typeof v === "string"
      ? v
      : "";

/** From a starter's JAR (only its classes are read; nothing in it is run). */
export function learnFrameworkFromJar(
  jar: Uint8Array,
  o: { name: string; jarName: string; packages?: string[] },
): { model: FrameworkModel; notes: string[] } {
  const sha = createHash("sha256").update(jar).digest("hex");
  const src = (entry: string): FrameworkSource => ({
    kind: "bytecode",
    ref: `${o.jarName}!${entry} sha256:${sha}`,
  });
  const c = collected();
  const archive = readZip(jar);
  const clientPrefixes = CLIENT_PACKAGES.map((p) => `${p}.`);
  for (const entry of [...archive.names].sort()) {
    if (/^META-INF\/maven\/[^/]+\/[^/]+\/pom\.properties$/.test(entry)) {
      const props = archive.text(entry) ?? "";
      const g = /^groupId=(.+)$/m.exec(props)?.[1]?.trim();
      const a = /^artifactId=(.+)$/m.exec(props)?.[1]?.trim();
      if (g && a) c.artifacts.push(`${g}:${a}`);
      continue;
    }
    if (!entry.endsWith(".class") || entry.endsWith("module-info.class")) continue;
    let cls;
    try {
      cls = parseClass(archive.read(entry)!);
    } catch (e) {
      if (e instanceof ClassFileError) continue; // a class it can't read teaches nothing
      throw e;
    }
    if (cls.packageName) c.packages.add(cls.packageName);
    if (cls.isAnnotation) {
      const aliases = new Map<string, { annotation?: string; attribute: string }>();
      for (const m of cls.methods) {
        const al = m.annotations.find((a: ClassAnnotation) => a.name === "AliasFor");
        if (!al) continue;
        const annotation =
          typeof al.values.annotation === "string" ? al.values.annotation : undefined;
        const attribute =
          (typeof al.values.attribute === "string" && al.values.attribute) ||
          (typeof al.values.value === "string" && al.values.value) ||
          m.name;
        aliases.set(m.name, { ...(annotation ? { annotation } : {}), attribute });
      }
      c.house.set(cls.simpleName, {
        source: src(entry),
        metas: cls.annotations
          .filter((a) => !JAVA_META.has(a.name))
          .map((a) => ({
            name: a.name,
            attrs: Object.fromEntries(Object.entries(a.values).map(([k, v]) => [k, attrValue(v)])),
          })),
        aliases,
      });
      continue;
    }
    for (const f of cls.fields)
      if (f.isStatic && f.isFinal && f.constant !== undefined)
        addConstant(c, cls.simpleName, f.name, f.constant, src(entry));
    if (!cls.references.some((r) => clientPrefixes.some((p) => r.startsWith(p)))) continue;
    for (const m of cls.methods) {
      if (!m.isPublic || m.isStatic || m.name === "<init>" || m.name === "<clinit>") continue;
      const cl = clientOf(cls.simpleName, m.name, m.params, src(entry));
      if (cl) c.clients.push(cl);
    }
  }
  return assemble(c, o);
}

/** The longest dotted prefix every package name shares: tide.platform.web + tide.platform.http → tide.platform. */
function commonPrefix(names: string[]): string {
  if (names.length === 0) return "";
  const parts = names.map((n) => n.split("."));
  const out: string[] = [];
  for (let i = 0; i < parts[0]!.length; i++) {
    const p = parts[0]![i]!;
    if (parts.every((x) => x[i] === p)) out.push(p);
    else break;
  }
  return out.join(".");
}
