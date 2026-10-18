// Regenerates docs/api/openapi.json from the zod contracts. Run with: pnpm api:doc
import { writeFileSync } from "node:fs";
import { openApiDocument } from "../packages/core/dist/index.js";

writeFileSync(
  new URL("../docs/api/openapi.json", import.meta.url),
  JSON.stringify(openApiDocument(), null, 2) + "\n",
);
console.log("Wrote docs/api/openapi.json");
