// node ../../scripts/bundle/learn-fixtures.mjs [--remove]   (run in packages/learn)
// @maycombhq/learn's prepack and postpack (ADR 0124 addendum D-npm): `atticus sandbox create`
// builds the practice metarepo from the invented Forge fixtures (fixtures/forge and
// fixtures/forge-change), which an npm install has no checkout to find. Prepack copies them into
// the package's own fixtures/ folder (gitignored), which `files` publishes and findFixtures()
// finds first; postpack removes it again, so a checkout keeps reading the repo's fixtures.
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const out = join(REPO, "packages", "learn", "fixtures");
rmSync(out, { recursive: true, force: true });
if (!process.argv.includes("--remove")) {
  for (const f of ["forge", "forge-change"]) {
    const from = join(REPO, "fixtures", f);
    if (!existsSync(join(from, "README.md")) && f === "forge") {
      console.error(`${from} isn't there: pack @maycombhq/learn from an Atticus checkout.`);
      process.exit(1);
    }
    cpSync(from, join(out, f), { recursive: true });
  }
  console.log("Copied fixtures/forge and fixtures/forge-change into packages/learn/fixtures.");
}
