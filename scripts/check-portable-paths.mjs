// File paths that work on Windows too. `new URL(..., import.meta.url).pathname` gives
// "/C:/Users/..." on Windows, which `join` turns into "C:\C:\Users\..."; use fileURLToPath.
// `import()` of a plain path fails on Windows ("C:\..." is not a URL); use pathToFileURL(...).href.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", "dist", "fixtures", "coverage", "test-results"]);
const EXT = /\.(m?js|cjs|m?ts|tsx)$/;
const RULES = [
  {
    re: /import\.meta\.url\s*\)\s*\.pathname/,
    why: "URL.pathname is not a file path on Windows: use fileURLToPath(new URL(..., import.meta.url))",
  },
  {
    re: /\bimport\(\s*(?:join|resolve)\(/,
    why: "import() needs a URL on Windows: use import(pathToFileURL(path).href)",
  },
];

const problems = [];
function walk(dir) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e) || e.startsWith(".")) continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f);
    else if (EXT.test(e) && f !== fileURLToPath(import.meta.url)) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const r of RULES)
          if (r.re.test(line)) problems.push(`${relative(ROOT, f)}:${i + 1}: ${r.why}`);
      });
    }
  }
}
for (const d of ["scripts", "packages"]) walk(join(ROOT, d));

if (problems.length) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log("Portable paths: ok");
