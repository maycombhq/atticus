import type { RepoHandle } from "@maycombhq/sdk";

/** One house artifact a repo declares, where it says so. */
export interface HouseDependency {
  group: string;
  artifact: string;
  /** As declared, ${properties} filled from the same pom; undefined when managed elsewhere. */
  version?: string;
  path: string;
}

/**
 * The house artifacts a repo builds on (ADR 0054): the dependencies its Maven poms (every
 * module, with `${property}` versions filled from the same pom) and Gradle builds declare,
 * whose group starts with one of `groups`. Files only; sorted by group, artifact, version.
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
  ])) {
    const text = await repo.readText(path);
    if (path.endsWith("pom.xml")) {
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
