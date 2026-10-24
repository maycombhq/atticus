#!/usr/bin/env node
import { main } from "./main.js";

// Output piped into a reader that stops early (`| head`) closes the pipe: stop quietly, not
// with a crash.
for (const stream of [process.stdout, process.stderr])
  stream.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw e;
  });

main(process.argv.slice(2), {
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // Something Atticus didn't expect: say so plainly, and where the details are. Nothing
    // written so far is half-done (every file is written whole), so running it again is safe.
    const message = err instanceof Error ? err.message : String(err);
    const logFile = (err as { logFile?: string } | null)?.logFile;
    process.stderr.write(`atticus: ${message}\n`);
    process.stderr.write(
      logFile
        ? `The details are in ${logFile}. To report it, run atticus support bundle and read what it collected before you send it.\n`
        : "Run it again with --root <metarepo> to keep a log of what happened.\n",
    );
    process.exitCode = 1;
  },
);
