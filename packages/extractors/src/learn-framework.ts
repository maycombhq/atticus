import { FrameworkModel, type FrameworkSource } from "@maycombhq/core";
import type { RepoHandle } from "@maycombhq/sdk";
import { parseJava } from "./lang/java.js";
import { CLIENT_PACKAGES, READ_ANNOTATIONS } from "./spring.js";

/**
 * Learn a framework model (ADR 0054) from a house starter's source repo: deterministic, files
 * only. What it reads:
 *
 * - each `@interface`: the annotations it is meta-annotated with that the Spring extractor
 *   reads (or other house annotations, expanded), `@AliasFor` members as the attribute mapping,
 *   and attribute values on a meta-annotation as fixed values (`@Op(verb = "GET")`);
 * - each public method of a class that uses an HTTP client whose parameters name a path
 *   (path, uri, url) and a method (method, verb) or whose name is a verb (get, post): a wrapper
 *   client, with the positions of its service, method and path arguments;
 * - each `static final String` constant, as Class.NAME.
 *
 * Every entry's source is `code` with the file it came from. What code can't say (a service
 * id's base URL) is returned in `notes`, for a person or a document to add.
 */
export async function learnFramework(
  repo: RepoHandle,
  o: { name: string; packages?: string[] },
): Promise<{ model: FrameworkModel; notes: string[] }> {
  const src = (path: string): FrameworkSource => ({ kind: "code", ref: `${repo.name}:${path}` });
  type House = {
    path: string;
    metas: { name: string; attrs: Record<string, string | string[]> }[];
    aliases: Map<string, { annotation?: string; attribute: string }>;
  };
  const house = new Map<string, House>();
  const clients: FrameworkModel["clients"] = [];
  const constants: FrameworkModel["constants"] = {};
  const packages = new Set<string>();
  const artifacts: string[] = [];
  const serviceIds: string[] = [];

  for await (const path of repo.listFiles(["**/*.java", "**/pom.xml"])) {
    if (/(^|\/)src\/test\//.test(path)) continue;
    const text = (await repo.readText(path)).replace(/\r\n/g, "\n");
    if (path.endsWith("pom.xml")) {
      if (path === "pom.xml") {
        const own = text.replace(
          /<parent>[\s\S]*?<\/parent>|<dependencies>[\s\S]*?<\/dependencies>/g,
          "",
        );
        const g = /<groupId>\s*([\w.-]+)\s*<\/groupId>/.exec(own)?.[1];
        const a = /<artifactId>\s*([\w.-]+)\s*<\/artifactId>/.exec(own)?.[1];
        if (g && a) artifacts.push(`${g}:${a}`);
      }
      continue;
    }
    const file = parseJava(text);
    if (file.packageName) packages.add(file.packageName);

    for (const d of file.decls.filter((x) => x.kind === "annotation-type")) {
      const aliases = new Map<string, { annotation?: string; attribute: string }>();
      for (const m of bodyOf(text, `@interface ${d.name}`).matchAll(
        /@AliasFor\s*\(([^)]*)\)\s*[\w.<>[\]]+\s+(\w+)\s*\(\s*\)/g,
      )) {
        const inner = m[1]!;
        const annotation = /annotation\s*=\s*(\w+)\.class/.exec(inner)?.[1];
        const attribute =
          /attribute\s*=\s*"(\w+)"/.exec(inner)?.[1] ??
          /^\s*"(\w+)"\s*$/.exec(inner)?.[1] ??
          /value\s*=\s*"(\w+)"/.exec(inner)?.[1] ??
          m[2]!;
        aliases.set(m[2]!, { ...(annotation ? { annotation } : {}), attribute });
      }
      house.set(d.name, {
        path,
        metas: d.annotations
          .filter((a) => !JAVA_META.has(a.name))
          .map((a) => ({ name: a.name, attrs: a.attrs })),
        aliases,
      });
    }

    const owner = file.decls.find((x) => x.kind === "class" && !x.parent)?.name;
    if (!owner) continue;
    for (const m of text.matchAll(
      /static\s+final\s+String\s+(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/g,
    )) {
      constants[`${owner}.${m[1]!}`] = { value: m[2]!, source: src(path) };
      if (/service/i.test(owner)) serviceIds.push(`${owner}.${m[1]!}`);
    }
    if (!CLIENT_PACKAGES.some((p) => file.imports.some((i) => i.startsWith(p)))) continue;
    for (const m of text.matchAll(
      /public\s+(?:static\s+)?(?:<[^>]+>\s+)?[\w.<>[\]?,\s]+?\s+(\w+)\s*\(([^)]*)\)\s*\{/g,
    )) {
      const method = m[1]!;
      if (method === owner) continue;
      const names = m[2]!
        .split(",")
        .map((p) => p.trim().split(/\s+/).pop() ?? "")
        .filter(Boolean);
      const at = (re: RegExp) => names.findIndex((n) => re.test(n));
      const service = at(/^(service|serviceId|serviceName|target|system)$/i);
      const verb = at(/^(method|verb|httpMethod)$/i);
      const pathArg = at(/^(path|uri|url|endpoint)$/i);
      const byName = /^(get|post|put|delete|patch)/i.exec(method)?.[1]?.toUpperCase();
      if (pathArg < 0 || (verb < 0 && !byName)) continue;
      clients.push({
        type: owner,
        method,
        ...(service >= 0 ? { service: { arg: service } } : {}),
        httpMethod: verb >= 0 ? { arg: verb } : { value: byName! },
        path: { arg: pathArg },
        source: src(path),
      });
    }
  }

  // What each house annotation means in the extractor's terms, house-on-house expanded.
  const resolve = (
    name: string,
    seen: Set<string>,
  ): { means: string[]; attributes: Record<string, string>; fixed: Record<string, string> } => {
    const h = house.get(name)!;
    const means: string[] = [];
    const attributes: Record<string, string> = {};
    const fixed: Record<string, string> = {};
    const one = (v: string | string[]) => String(Array.isArray(v) ? v[0] : v).replace(/^.*\./, "");
    for (const meta of h.metas) {
      if (READ_ANNOTATIONS.has(meta.name)) {
        means.push(meta.name);
        for (const [k, v] of Object.entries(meta.attrs)) fixed[k] = one(v);
      } else if (house.has(meta.name) && !seen.has(meta.name)) {
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
      else if (house.has(al.annotation) && !seen.has(al.annotation)) {
        const to = resolve(al.annotation, new Set([...seen, al.annotation])).attributes[
          al.attribute
        ];
        if (to) attributes[member] = to;
      }
    }
    return { means: [...new Set(means)], attributes, fixed };
  };
  const annotations: FrameworkModel["annotations"] = [];
  for (const name of [...house.keys()].sort()) {
    const r = resolve(name, new Set([name]));
    if (r.means.length > 0) annotations.push({ name, ...r, source: src(house.get(name)!.path) });
  }

  const notes: string[] = [];
  if (serviceIds.length > 0)
    notes.push(
      `${serviceIds.sort().join(", ")} look like service ids: their base URLs aren't in the code; add them under services: (from the registry's config or a person).`,
    );
  const model = FrameworkModel.parse({
    schemaVersion: 1,
    name: o.name,
    packages: o.packages ?? [commonPrefix([...packages])].filter(Boolean),
    artifacts,
    annotations,
    clients,
    services: {},
    constants: Object.fromEntries(Object.entries(constants).sort(([a], [b]) => (a < b ? -1 : 1))),
  });
  return { model, notes };
}

/** Java's own meta-annotations: they say how an annotation works, not what it means. */
const JAVA_META = new Set(["Target", "Retention", "Documented", "Inherited", "Repeatable"]);

/** The text between the "{" after `head` and its matching "}". */
function bodyOf(text: string, head: string): string {
  const start = text.indexOf("{", text.indexOf(head));
  if (start < 0) return "";
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start + 1, i);
  }
  return text.slice(start + 1);
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
