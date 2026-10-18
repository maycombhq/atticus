// Regenerates the contract pages and the index of docs/spec/ from the zod contracts and their
// doc comments, formatted with the repo's prettier settings. Run with: pnpm spec:doc
// The concept pages in docs/spec/concepts/ and docs/spec/VERSION are written by hand.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { specPages } from "../packages/conformance/dist/index.js";

const root = new URL("../docs/spec/", import.meta.url);
const pages = specPages();
for (const [path, text] of Object.entries(pages)) {
  const file = fileURLToPath(new URL(path, root));
  const options = (await resolveConfig(file)) ?? {};
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, await format(text, { ...options, parser: "markdown" }));
}
console.log(`Wrote ${Object.keys(pages).length} pages in docs/spec`);
