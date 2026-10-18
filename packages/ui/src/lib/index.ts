import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the built app's files are, for the local server to hand out. */
export function uiDistDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
}
