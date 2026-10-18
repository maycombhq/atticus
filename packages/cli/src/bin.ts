#!/usr/bin/env node
import { main } from "./main.js";

main(process.argv.slice(2), {
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`atticus: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
