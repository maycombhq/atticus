import type { RepoHandle } from "@maycombhq/sdk";
import { repoConfigFor } from "./facts.js";

/**
 * The deployable modules of a multi-module repo (ADR 0057): folders with their own build file
 * (pom.xml, build.gradle, build.gradle.kts) whose production code has a @SpringBootApplication
 * class. With two or more, each is its own component, named by its spring.application.name
 * (its own config first, then the repo's), else by its folder. With fewer, the repo is one
 * component and this returns nothing. Files only.
 */
export async function detectModules(
  repo: RepoHandle,
): Promise<{ path: string; component: string }[]> {
  const skip = /(^|\/)(node_modules|target|build|out|\.gradle)\//;
  const dirs: string[] = [];
  for await (const p of repo.listFiles(["**/pom.xml", "**/build.gradle", "**/build.gradle.kts"])) {
    if (skip.test(p)) continue;
    const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  }
  if (dirs.length < 2) return [];
  /** The deepest module folder holding a file. */
  const ownerOf = (file: string) =>
    dirs.filter((d) => file.startsWith(`${d}/`)).sort((a, b) => b.length - a.length)[0];
  const apps = new Set<string>();
  for await (const p of repo.listFiles(["**/*.java", "**/*.kt"])) {
    if (skip.test(p) || !/(^|\/)src\/main\//.test(p)) continue;
    const owner = ownerOf(p);
    if (!owner || apps.has(owner)) continue;
    if (/@SpringBootApplication\b/.test(await repo.readText(p))) apps.add(owner);
  }
  if (apps.size < 2) return [];
  const configFor = await repoConfigFor(repo);
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+|-+$/g, "");
  return [...apps].sort().map((path) => {
    const name = configFor(`${path}/src/main/x`).get("spring.application.name")?.value;
    const fromConfig = name && !name.includes("${") ? slug(name) : "";
    return { path, component: fromConfig || slug(path.split("/").pop()!) };
  });
}
