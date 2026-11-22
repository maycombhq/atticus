// Regenerates docs/api/openapi.json from the zod contracts. Run with: pnpm api:doc
import { writeFileSync } from "node:fs";

// --help prints the usage and writes nothing (the whole-release review of beta.30).
if (process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
  console.log(
    "Usage: node scripts/write-api-doc.mjs\nWrites docs/api/openapi.json from the local API's zod contracts (packages/core, built first: pnpm api:doc builds it).",
  );
  process.exit(0);
}
if (process.argv.length > 2) {
  console.error(
    `Unknown argument ${process.argv[2]}. It takes none (or --help). Nothing was written.`,
  );
  process.exit(2);
}

const { openApiDocument } = await import("../packages/core/dist/index.js");
writeFileSync(
  new URL("../docs/api/openapi.json", import.meta.url),
  JSON.stringify(openApiDocument(), null, 2) + "\n",
);
console.log("Wrote docs/api/openapi.json");
