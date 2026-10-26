// node --import ./loaded-modules-hook.mjs: writes the URL of every module the process loads, one
// per line, to the file ATTICUS_LOADED_FILE names, when the process exits (startup.test.ts).
import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";

const loaded = [];
registerHooks({
  load(url, context, next) {
    loaded.push(url);
    return next(url, context);
  },
});
process.on("exit", () => {
  if (process.env.ATTICUS_LOADED_FILE)
    writeFileSync(process.env.ATTICUS_LOADED_FILE, loaded.join("\n") + "\n");
});
