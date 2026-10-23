// Writes docs/evidence/context-eval.md: the context engine's eval on the Forge fixtures (ADR
// 0107 point 6), with the whole lists and with the engine, at two budgets. Run after a build:
//   pnpm --filter @maycombhq/evals... build && node packages/evals/scripts/write-context-eval.mjs
// The evals' tests check the file is up to date.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderContextTable, runContextBench } from "../dist/index.js";

const fixtures = fileURLToPath(new URL("../../../fixtures", import.meta.url));
const out = fileURLToPath(new URL("../../../docs/evidence/context-eval.md", import.meta.url));
const rows = await runContextBench({ fixtures });
writeFileSync(out, renderContextTable(rows));
console.log(`Wrote ${out}`);
