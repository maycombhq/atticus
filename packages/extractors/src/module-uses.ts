import type { RepoHandle } from "@maycombhq/sdk";
import { at } from "./lang/parsed.js";
import { parseXml, select, selectText } from "./lang/xml.js";

/**
 * What each component of a repo builds on (ADR 0068): for the repo's own component (at its
 * root) and each module, the other components of the repo its build file depends on. A pom's
 * own `<dependencies>` count (not `<dependencyManagement>`, which only pins versions), matched
 * by artifactId to the pom of another module; a package.json's dependencies, dev and peer
 * dependencies, matched by name to another module's package.json. Files only; sorted.
 * Gradle `project(":x")` dependencies aren't read yet.
 */
export async function moduleUses(
  repo: RepoHandle,
  components: readonly { path: string; component: string }[],
): Promise<Map<string, string[]>> {
  const file = async (path: string) => {
    try {
      return await repo.readText(path);
    } catch {
      return undefined;
    }
  };
  const own = new Map<string, string>(); // "maven:<artifactId>" or "npm:<name>" → component
  const deps = new Map<string, string[]>(); // component → keys it depends on
  for (const c of components) {
    const dir = c.path ? `${c.path}/` : "";
    const keys: string[] = [];
    const pomPath = `${dir}pom.xml`;
    const pomText = await file(pomPath);
    if (pomText !== undefined) {
      try {
        const pom = parseXml(pomText, at(repo, pomPath));
        const id = selectText(pom, "project/artifactId")?.text;
        if (id) own.set(`maven:${id}`, c.component);
        for (const d of select(pom, "project/dependencies/dependency")) {
          const a = selectText(d, "artifactId")?.text;
          if (a) keys.push(`maven:${a}`);
        }
      } catch {
        // a pom that doesn't parse declares nothing
      }
    }
    const pkgText = await file(`${dir}package.json`);
    if (pkgText !== undefined) {
      try {
        const pkg = JSON.parse(pkgText) as Record<string, unknown>;
        if (typeof pkg.name === "string" && pkg.name) own.set(`npm:${pkg.name}`, c.component);
        for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
          const v = pkg[field];
          if (v && typeof v === "object") for (const n of Object.keys(v)) keys.push(`npm:${n}`);
        }
      } catch {
        // a package.json that doesn't parse declares nothing
      }
    }
    deps.set(c.component, keys);
  }
  const out = new Map<string, string[]>();
  for (const [component, keys] of deps) {
    const uses = [
      ...new Set(keys.map((k) => own.get(k)).filter((x): x is string => !!x && x !== component)),
    ].sort();
    if (uses.length) out.set(component, uses);
  }
  return out;
}
