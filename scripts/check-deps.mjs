// Every package imports only what its package.json declares (node: built-ins aside). In the
// monorepo a missing dependency still resolves through another package; in an installed
// bundle it doesn't, so this check stops it reaching an install.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const builtins = new Set(builtinModules);
// Test tools come from the workspace root (vitest, playwright, axe): tests may use those too.
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const rootDev = new Set(Object.keys({ ...rootPkg.devDependencies, ...rootPkg.dependencies }));
const problems = [];
const pkgs = readdirSync(join(root, "packages"));
for (const p of pkgs) {
  const dir = join(root, "packages", p);
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    continue;
  }
  const declared = new Set([
    pkg.name,
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);
  const devOk = new Set(Object.keys(pkg.devDependencies ?? {}));
  const walk = (d, test) => {
    let entries;
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e === "node_modules" || e === "dist" || e === "fixtures" || e.startsWith(".")) continue;
      const f = join(d, e);
      if (statSync(f).isDirectory()) walk(f, test);
      else if (/\.(ts|tsx|mts|js|mjs)$/.test(e) && !/\.d\.ts$/.test(e)) check(f, test);
    }
  };
  // A package whose src is bundled at build time (the app) ships no imports: devDependencies do.
  const bundled = /\bvite\b/.test(pkg.scripts?.build ?? "");
  const check = (file, test) => {
    // Comments and the code samples inside strings aren't imports.
    const text = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
      .replace(/'(?:\\.|[^'\\\n])*import[^'\n]*'/g, "''");
    const re =
      /(?:^|[\s;])(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^import\s+["']([^"']+)["']/gm;
    for (const m of text.matchAll(re)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:"))
        continue;
      const name = spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : spec.split("/")[0];
      if (builtins.has(name)) continue;
      if (declared.has(name)) continue;
      if ((test || bundled) && (devOk.has(name) || rootDev.has(name))) continue;
      problems.push(
        `${pkg.name}: ${file.slice(root.length)} imports ${name}, which its package.json doesn't declare${test ? "" : " in dependencies"}`,
      );
    }
  };
  walk(join(dir, "src"), false);
  walk(join(dir, "test"), true);
  walk(join(dir, "e2e"), true);
  walk(join(dir, "support"), true);
  walk(join(dir, "tests"), true);
}
if (problems.length) {
  for (const p of [...new Set(problems)]) console.error(p);
  console.error(`\n${new Set(problems).size} undeclared imports.`);
  process.exit(1);
}
console.log(`Dependency check passed (${pkgs.length} packages).`);
