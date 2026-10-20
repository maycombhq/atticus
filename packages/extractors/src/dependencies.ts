import type { RepoHandle } from "@maycombhq/sdk";

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
 * sorted by group, artifact, version.
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
      const props = new Map<string, string>();
      for (const block of text.match(/<properties>[\s\S]*?<\/properties>/g) ?? [])
        for (const m of block.matchAll(/<([\w.-]+)>\s*([^<]*?)\s*<\/\1>/g)) props.set(m[1]!, m[2]!);
      const fill = (v: string) =>
        v.replace(/\$\{([\w.-]+)\}/g, (s, k: string) => props.get(k) ?? s);
      for (const m of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
        const tag = (t: string) => new RegExp(`<${t}>\\s*([^<]+?)\\s*</${t}>`).exec(m[1]!)?.[1];
        const group = tag("groupId");
        const artifact = tag("artifactId");
        if (!group || !artifact || !ours(group)) continue;
        const version = tag("version");
        out.push({ group, artifact, ...(version ? { version: fill(version) } : {}), path });
      }
    } else {
      for (const m of text.matchAll(/["']([\w.-]+):([\w.-]+)(?::([\w.+-]+))?["']/g)) {
        if (!ours(m[1]!)) continue;
        out.push({ group: m[1]!, artifact: m[2]!, ...(m[3] ? { version: m[3] } : {}), path });
      }
    }
  }
  const key = (d: HouseDependency) => `${d.group}\u0000${d.artifact}\u0000${d.version ?? ""}`;
  return out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
