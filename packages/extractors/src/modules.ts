import type { RepoHandle } from "@maycombhq/sdk";
import { repoConfigFor } from "./facts.js";
import { UI_PACKAGES } from "./module-uses.js";

/**
 * The deployable modules of a multi-part repo (ADR 0057, W1): the parts a repo builds and runs
 * on their own. A part is a Spring Boot app (a folder with its own build file, pom.xml,
 * build.gradle or build.gradle.kts, whose production code has a @SpringBootApplication class),
 * a browser app (a folder whose package.json depends on a UI framework, React, Vue, Angular,
 * Svelte or Preact, and not on react-native or electron, which are the apps reader's), or an
 * Android app (the folder of the build file nearest an AndroidManifest.xml with an
 * <application>). With two or more parts, each part in a folder is its own component: a Spring
 * app named by its spring.application.name (its own config first, then the repo's), a browser
 * app by its package.json name without the scope, an Android app by its folder's path, else by
 * its folder. A part at the repo's root stays the repo's own component. With fewer parts, the
 * repo is one component and this returns nothing. Files only.
 */
export async function detectModules(
  repo: RepoHandle,
): Promise<{ path: string; component: string }[]> {
  const skip = /(^|\/)(node_modules|target|build|out|dist|\.gradle)\//;
  const builds: string[] = [];
  const dirs: string[] = [];
  for await (const p of repo.listFiles(["**/pom.xml", "**/build.gradle", "**/build.gradle.kts"])) {
    if (skip.test(p)) continue;
    const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    if (!builds.includes(dir)) builds.push(dir);
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  }
  /** The deepest module folder holding a file. */
  const ownerOf = (file: string) =>
    dirs.filter((d) => file.startsWith(`${d}/`)).sort((a, b) => b.length - a.length)[0];
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+|-+$/g, "");
  const parts = new Map<string, string>();
  let rootPart = false;

  // Spring Boot apps.
  const apps = new Set<string>();
  for await (const p of repo.listFiles(["**/*.java", "**/*.kt"])) {
    if (skip.test(p) || !/(^|\/)src\/main\//.test(p)) continue;
    const owner = ownerOf(p);
    if ((owner && apps.has(owner)) || (!owner && rootPart)) continue;
    if (!/@SpringBootApplication\b/.test(await repo.readText(p))) continue;
    if (owner) apps.add(owner);
    else if (builds.includes("")) rootPart = true;
  }
  const configFor = apps.size ? await repoConfigFor(repo) : undefined;
  for (const path of apps) {
    const name = configFor!(`${path}/src/main/x`).get("spring.application.name")?.value;
    const fromConfig = name && !name.includes("${") ? slug(name) : "";
    parts.set(path, fromConfig || slug(path.split("/").pop()!));
  }

  // Browser apps.
  for await (const p of repo.listFiles(["**/package.json"])) {
    if (skip.test(p)) continue;
    let pkg: { name?: unknown } & Record<string, Record<string, unknown> | undefined>;
    try {
      pkg = JSON.parse(await repo.readText(p)) as typeof pkg;
    } catch {
      continue;
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    if (!UI_PACKAGES.some((u) => u in deps) || "react-native" in deps || "electron" in deps)
      continue;
    const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    if (!dir) {
      rootPart = true;
      continue;
    }
    if (parts.has(dir)) continue;
    const named = typeof pkg.name === "string" ? slug(pkg.name.replace(/^@[^/]+\//, "")) : "";
    parts.set(dir, named || slug(dir.split("/").pop()!));
  }

  // Android apps.
  for await (const p of repo.listFiles(["**/AndroidManifest.xml"])) {
    if (skip.test(p) || !/(^|\/)src\/main\/AndroidManifest\.xml$/.test(p)) continue;
    if (!/<application\b/.test(await repo.readText(p))) continue;
    const dir = ownerOf(p);
    if (!dir) {
      if (builds.includes("")) rootPart = true;
      continue;
    }
    if (!parts.has(dir)) parts.set(dir, slug(dir.replace(/\//g, "-")));
  }

  if (parts.size + (rootPart ? 1 : 0) < 2) return [];
  return [...parts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, component]) => ({ path, component }));
}
