# 0080. Scanner plugins: pinned, tested, run in a sandbox (C4, C6)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-21
- Builds on: ADR 0074 (the AI reads; every fact cites its code), ADR 0016 (plugin SDK)

## Context

ADR 0074 has the AI customise the scanner with the lightest thing that works: a rule file when the rule format can say it, a scanner plugin in code when it can't. A plugin is code the AI wrote, so a bank must be able to see that it only reads, only the repo, and only what was reviewed. Until now the SDK had extractors (C4) but nowhere in the org pack to put one, nothing that stops it once it runs, and nothing that ties the code that runs to the code that was reviewed.

## Decision

**C6: a plugin is a folder in the org pack**, `org-pack/plugins/<id>/` (schema `ScannerPlugin`, schema version 1):

```yaml
schemaVersion: 1
id: forge-anvil-routes
version: 1.0.0
description: Reads the HTTP entry points of the Forge Anvil house framework.
emits: [Endpoint] # C1 kinds; any other kind fails the run
appliesTo:
  repoTypes: [anvil-service] # "*" for any; or dialects: [...]
entry: index.js # plain JavaScript ES module, default export an Extractor (C4)
limits: { timeoutMs: 10000, memoryMb: 64 }
sha256: 7e2f01... # written by atticus plugin pin
enabled: true
```

Golden tests sit beside it: `test/<case>/repo/` and `test/<case>/expected.yaml` (`expect` records matched by kind and id with the fields listed, `absent`, `exact` default true so nothing else may be produced, and an optional `context`). The test repo is named after the case.

**The scanner uses a plugin only when** it is enabled, its entry file's sha256 (line endings normalised to LF) equals the pin, and its golden tests pass, re-run before every scan. Anything else is a scan problem and the plugin isn't used. It runs after the built-ins, on the repos it applies to, as extractor `plugin-<id>`; its records are validated against C1 like any extractor's, and the cache key carries the pin and the limits.

**C4: the sandbox** (`sandboxedExtractor` in `@maycombhq/sdk`). Each run gets a fresh worker thread and the plugin's source is compiled there as a `vm.SourceTextModule` in a fresh `vm` context. A run that is stopped or blocked is a failed run with the reason; the scan goes on.

`atticus plugin test <id>` runs the golden tests in the sandbox and says whether the pin still holds; `atticus plugin pin <id>` writes the sha256 into `plugin.yaml`, which is committed with the code in the same reviewed change.

## What is enforced

- **Time:** the host terminates the worker at `timeoutMs`, including a loop with no await and a loop while the module loads.
- **Memory:** `resourceLimits.maxOldGenerationSizeMb = memoryMb` (young generation and code range capped too); running out ends the worker, reported as over the limit. A run may also return at most 100,000 records.
- **Files:** the plugin has no file system. `repo.listFiles` and `repo.readText` are messages the host answers from the scan's RepoHandle (fsRepo already refuses symlinks, paths that resolve outside the repo, and oversize files). A path or glob that is absolute, has `..` or a backslash is blocked and stops the run. There is no write call to make.
- **No Node:** the context has only the ECMAScript built-ins. `require`, `process`, `module`, `Buffer`, `fetch`, `XMLHttpRequest`, `WebSocket`, timers, `queueMicrotask`, `WebAssembly`, `SharedArrayBuffer` and `Atomics` are traps that report what was tried. Every static import fails at link time, and every dynamic `import()` is refused, each reported with its specifier (`node:fs`, `node:net`, `node:child_process`, `node:worker_threads`, anything else).
- **No code from strings:** the context is created with code generation from strings and Wasm off, and every reachable Function constructor (`Function`, async, generator, async generator) and `eval` is a trap.
- **Determinism (ADR 0074):** `Date` and `Math.random` are traps; the scan's time is `ctx.scannedAt`.
- **Nothing to climb out by:** the plugin is only ever handed objects made in its own context. The host side of the bridge is called only with strings and numbers, its errors are made in the plugin's context, and it never awaits a promise the plugin made. The built-in prototypes and the global object are frozen before the plugin's code runs.
- **The worker itself** starts with an empty environment (`env: {}`), no argv, no stdin, and its stdout and stderr go nowhere.
- **What it emits:** only the kinds its manifest names, and the module must export the id and version its manifest names.

## What is not enforced, and what a stronger boundary needs

- **Node's `vm` is not a security boundary.** Node's own documentation says so. The plugin runs in the same process as the scanner, in a V8 isolate the worker shares with Atticus code that does have Node. A V8 or Node bug that lets code leave a context, or a gap in the freeze (the freeze here is a short list, not a full lockdown such as SES), would give a plugin everything the scanner process has: the file system, the network, the environment, child processes. The review, the pin and the golden tests are the first line of defence; the sandbox stops mistakes and casual misuse.
- **CPU, not just wall time,** is shared: a plugin can use one core until its time limit. Spectre-class side channels within the process are not addressed.
- **The OS sees one process.** Nothing stops the scanner process itself from reaching the network; Atticus's own rule (CLAUDE.md rule 4) is the only limit there.
- **What it reads:** any file in the repo the scan reads, not only the globs it claims, and the repo's text can be read in full into the plugin's memory.

A boundary a bank can rely on against hostile code needs the OS to enforce it: run each plugin in a separate process with no network namespace (or a container with `--network none`), a read-only mount of only the repo at that commit, seccomp or AppArmor/SELinux (Linux) or an AppContainer/Job Object (Windows) that denies process creation and outbound sockets, cgroup or Job Object CPU and memory limits, and an unprivileged user. Or a separate engine: a WebAssembly runtime with WASI exposing only a read-only directory, or an isolate library such as `isolated-vm` with no Node in the isolate at all. The message protocol here (list, read, record, warn, done) is designed so the host side doesn't change when the worker moves into such a process.

## Consequences

- C6 gains an optional folder kind (`plugins/`) and C4 gains `sandboxedExtractor`, `readPinnedEntry` and `pluginEntryHash`; nothing existing changes, so no migration. An org pack without `plugins/` scans exactly as before.
- Scans with plugins cost a worker start (tens of milliseconds) per plugin per repo and per test case; the tests are re-run on every scan so an edited test or a changed reader can't slip through.
- A plugin is plain JavaScript in one file: no imports, no npm packages. A plugin that needs a parser asks for one to be added to the SDK, which is a reviewed Atticus change.
- Not built yet: the AI drafting a plugin (the `atticus scan survey` loop of ADR 0075 extended to code), and an OS-level boundary.
