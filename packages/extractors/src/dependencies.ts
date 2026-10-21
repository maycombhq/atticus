import type { RepoHandle } from "@maycombhq/sdk";
import { groovyCalls } from "./lang/groovy.js";
import type Parser from "web-tree-sitter";
import { at, type ParsedAt } from "./lang/parsed.js";
import { useSyntaxTree } from "./lang/syntax.js";
import { parseXml, select, selectText } from "./lang/xml.js";

/** One house artifact a repo declares, where it says so. */
export interface HouseDependency {
  group: string;
  artifact: string;
  /** As declared, ${properties} filled from the same pom; undefined when managed elsewhere. */
  version?: string;
  path: string;
  /** Set for an npm package: group is its scope (@tide) or its name, artifact the rest. */
  ecosystem?: "npm";
}

/**
 * The house artifacts a repo builds on (ADR 0054): the dependencies its Maven poms (every
 * module, with `${property}` versions filled from the same pom) and Gradle builds declare,
 * whose group starts with one of `groups`, and the npm packages its package.json files depend
 * on whose scope or name is one of them (`@tide`, `@tide/lantern`; ADR 0055). Files only;
 * sorted by group, artifact, version. Poms go through the XML reader and Kotlin DSL builds
 * through the Kotlin syntax tree (ADR 0060).
 */
export async function houseDependencies(
  repo: RepoHandle,
  groups: readonly string[],
): Promise<HouseDependency[]> {
  const ours = (g: string) => groups.some((p) => g === p || g.startsWith(`${p}.`));
  const out: HouseDependency[] = [];
  for await (const path of repo.listFiles([
    "**/pom.xml",
    "**/build.gradle",
    "**/build.gradle.kts",
    "**/package.json",
  ])) {
    if (/(^|\/)node_modules\//.test(path)) continue;
    const text = await repo.readText(path);
    if (path.endsWith("package.json")) {
      let pkg: Record<string, unknown>;
      try {
        pkg = JSON.parse(text) as Record<string, unknown>;
      } catch {
        continue;
      }
      for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
        const deps = pkg[field];
        if (!deps || typeof deps !== "object") continue;
        for (const [name, v] of Object.entries(deps as Record<string, unknown>)) {
          const scope = name.startsWith("@") ? name.split("/")[0]! : undefined;
          if (!groups.some((g) => g === name || g === scope || g === `${scope}/`)) continue;
          out.push({
            group: scope ?? name,
            artifact: scope ? name.slice(scope.length + 1) : name,
            ...(typeof v === "string" ? { version: v } : {}),
            path,
            ecosystem: "npm",
          });
        }
      }
    } else if (path.endsWith("pom.xml")) {
      const pom = parseXml(text, at(repo, path));
      const props = new Map<string, string>();
      for (const block of select(pom, "project/properties"))
        for (const p of block.children) props.set(p.name, p.text.trim());
      const fill = (v: string) =>
        v.replace(/\$\{([\w.-]+)\}/g, (s, k: string) => props.get(k) ?? s);
      // Every <dependency>: the project's, its modules' management, and plugins'.
      for (const d of select(pom, "//dependency")) {
        const group = selectText(d, "groupId")?.text;
        const artifact = selectText(d, "artifactId")?.text;
        if (!group || !artifact || !ours(group)) continue;
        const version = selectText(d, "version")?.text;
        out.push({ group, artifact, ...(version ? { version: fill(version) } : {}), path });
      }
    } else if (path.endsWith(".kts")) {
      for (const d of await kotlinDependencies(text, at(repo, path)))
        if (ours(d.group)) out.push({ ...d, path });
    } else {
      // Groovy build.gradle, from its syntax tree: "group:artifact[:version]" string arguments,
      // or group:, name:, version: named ones. Comments aren't read.
      for (const c of await groovyCalls(text, at(repo, path))) {
        for (const a of c.args) {
          const m = COORDINATE.exec(a);
          if (m && ours(m[1]!))
            out.push({ group: m[1]!, artifact: m[2]!, ...(m[3] ? { version: m[3] } : {}), path });
        }
        const { group, name, version } = c.named;
        if (group && name && ours(group))
          out.push({ group, artifact: name, ...(version ? { version } : {}), path });
      }
    }
  }
  const key = (d: HouseDependency) => `${d.group}\u0000${d.artifact}\u0000${d.version ?? ""}`;
  return out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

const COORDINATE = /^([\w.-]+):([\w.-]+)(?::([\w.+-]+))?$/;

/**
 * The coordinates a Kotlin DSL build declares, from its syntax tree: each call argument that is
 * "group:artifact[:version]", or group =, name =, version = named arguments. A version made
 * with a template ("…:$v") isn't known here: the coordinate is kept without it.
 */
async function kotlinDependencies(
  text: string,
  where?: ParsedAt,
): Promise<{ group: string; artifact: string; version?: string }[]> {
  return useSyntaxTree("kotlin", text, (tree) => kotlinCoordinates(tree.rootNode), where);
}

function kotlinCoordinates(
  root: Parser.SyntaxNode,
): { group: string; artifact: string; version?: string }[] {
  const out: { group: string; artifact: string; version?: string }[] = [];
  /** A string literal's parts: its text, and whether a template is in it. */
  const str = (n: Parser.SyntaxNode | undefined) => {
    if (n?.type !== "string_literal") return undefined;
    const parts = n.namedChildren;
    const literal = parts.filter((p) => p.type === "string_content").map((p) => p.text);
    return { text: literal.join(""), templated: parts.some((p) => p.type !== "string_content") };
  };
  const walk = (n: Parser.SyntaxNode) => {
    if (n.type === "value_arguments") {
      const named = new Map<string, string>();
      for (const a of n.namedChildren.filter((c) => c.type === "value_argument")) {
        const kids = a.namedChildren;
        const v = str(kids.at(-1));
        if (!v) continue;
        if (kids.length > 1 && kids[0]!.type === "simple_identifier") {
          if (!v.templated) named.set(kids[0]!.text, v.text);
          continue;
        }
        const m = COORDINATE.exec(v.text);
        if (m && !v.templated)
          out.push({ group: m[1]!, artifact: m[2]!, ...(m[3] ? { version: m[3] } : {}) });
        else if (v.templated) {
          // "tide.platform:tide-web-starter:$version": the coordinate without its version.
          const g = /^([\w.-]+):([\w.-]+):$/.exec(v.text);
          if (g) out.push({ group: g[1]!, artifact: g[2]! });
        }
      }
      const group = named.get("group");
      const artifact = named.get("name");
      if (group && artifact) {
        const version = named.get("version");
        out.push({ group, artifact, ...(version ? { version } : {}) });
      }
    }
    for (const c of n.namedChildren) walk(c);
  };
  walk(root);
  return out;
}
