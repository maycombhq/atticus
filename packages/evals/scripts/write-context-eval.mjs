// Writes docs/evidence/context-eval.md: the context engine's eval (ADR 0107 point 6, ADR 0116).
// The steps on the Forge fixtures with the whole lists and with the engine, at two budgets; then
// the retrieval cases (fixtures/retrieval) in each retrieval mode. Run after a build:
//   pnpm --filter @maycombhq/evals... build && pnpm --filter @maycombhq/evals eval:context
// The evals' tests check the file is up to date.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderContextEval, runContextEval } from "../dist/index.js";

const fixtures = fileURLToPath(new URL("../../../fixtures", import.meta.url));
const out = fileURLToPath(new URL("../../../docs/evidence/context-eval.md", import.meta.url));
writeFileSync(out, renderContextEval(await runContextEval(fixtures)));
console.log(`Wrote ${out}`);
