#!/usr/bin/env node
import { VERSION } from "./version.js";

// Output piped into a reader that stops early (`| head`) closes the pipe: stop quietly, not
// with a crash.
for (const stream of [process.stdout, process.stderr])
  stream.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw e;
  });

const argv = process.argv.slice(2);

// `atticus --version` answers before anything else loads: the editors and the app's server run
// it to check the install, and it must not wait for the commands (they load below, only when
// one runs). Kept as a dynamic import so a bundler keeps the split.
if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v"))
  process.stdout.write(VERSION + "\n");
else {
  // ATTICUS_MAX_OLD_SPACE (megabytes) is what a person is told to set when a repo's facts need
  // more memory than Node was given (ADR 0124 addendum A-room). A running V8 can't raise the heap
  // it already made, so the value is honoured by starting Node again with the flag, as
  // scripts/bundle/fetch-model.mjs starts again for a proxy. Unset — the ordinary run — nothing
  // is imported and nothing is spawned.
  if (process.env.ATTICUS_MAX_OLD_SPACE) {
    const { reExecForMemory } = await import("./memory-room.js");
    const again = reExecForMemory(process.env, process.execArgv);
    if (again) {
      const { spawnSync } = await import("node:child_process");
      const r = spawnSync(
        process.execPath,
        [`--max-old-space-size=${again.maxOldSpaceMB}`, process.argv[1]!, ...argv],
        { stdio: "inherit", env: { ...process.env, ATTICUS_RESTARTED_FOR_MEMORY: "1" } },
      );
      process.exit(r.status ?? 1);
    }
  }
  const { main } = await import("./main.js");
  await main(argv, {
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
}
