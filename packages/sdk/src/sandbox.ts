import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { CatalogRecord } from "@maycombhq/core";
import type { Extractor, RepoHandle, ScanContext } from "./plugin.js";

/**
 * The scanner plugin sandbox (ADR 0080, C4). An org-pack plugin is plain JavaScript the AI
 * wrote and a person reviewed; it still runs as if it were hostile:
 *
 * - in its own worker thread, with a heap limit (`resourceLimits`) and a wall-clock limit
 *   after which the worker is terminated;
 * - as an ES module compiled with `vm.SourceTextModule` in a fresh `vm` context: no `require`,
 *   no `process`, no `fetch`, no timers, no Node globals at all, and every import (static or
 *   dynamic) refused;
 * - code generation from strings off (`eval`, `Function`), and the built-in prototypes frozen
 *   before the plugin's code runs;
 * - files only through a message channel the host answers from the RepoHandle, for
 *   repo-relative paths only.
 *
 * Anything it tries that is forbidden stops the run, reported as a failed run with what it
 * tried; the scan goes on. Node's `vm` is not a security boundary against a determined
 * attacker (ADR 0080 says what is and isn't enforced); the review, the pin and the golden
 * tests are the first line, this is the second.
 */

/** What the sandbox needs from a plugin's manifest, and its entry file's source. */
export interface SandboxPlugin {
  id: string;
  version: string;
  /** Record kinds it may emit; any other kind fails the run. */
  emits: readonly string[];
  limits: { timeoutMs: number; memoryMb: number };
  /** The entry file's text: an ES module whose default export is an Extractor. */
  source: string;
  /** The entry file's name, for messages and stack traces. */
  entry?: string;
}

/** Plugins' records carry this prefix on their extractor id, so they can't pose as a built-in. */
export const PLUGIN_EXTRACTOR_PREFIX = "plugin-";

/** Most records one plugin run may return; more is a runaway plugin. */
const MAX_RECORDS = 100_000;

/** The sha256 of an entry file, with line endings normalised so every checkout agrees. */
export function pluginEntryHash(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/** Read a plugin's entry file, refusing one that isn't pinned or changed after it was pinned. */
export async function readPinnedEntry(
  dir: string,
  manifest: { entry: string; sha256?: string | undefined },
): Promise<{ ok: true; source: string } | { ok: false; message: string }> {
  if (!manifest.sha256)
    return { ok: false, message: "isn't pinned: run atticus plugin pin once it is reviewed" };
  let source: string;
  try {
    source = await readFile(join(dir, ...manifest.entry.split("/")), "utf8");
  } catch (e) {
    return { ok: false, message: `can't read ${manifest.entry}: ${(e as Error).message}` };
  }
  if (pluginEntryHash(source) !== manifest.sha256)
    return {
      ok: false,
      message: `${manifest.entry} changed after it was pinned: its sha256 isn't the one in plugin.yaml. Review the change, then run atticus plugin pin`,
    };
  return { ok: true, source };
}

/** Why a plugin run stopped, for the scan's problems. */
export class PluginRunError extends Error {
  constructor(
    message: string,
    readonly reason: "blocked" | "timeout" | "memory" | "failed" | "invalid",
  ) {
    super(message);
    this.name = "PluginRunError";
  }
}

/** A repo-relative path or glob: never absolute, never `..`, forward slashes only. */
function insideRepo(p: string): boolean {
  return (
    p.length > 0 &&
    !p.startsWith("/") &&
    !/^[A-Za-z]:/.test(p) &&
    !p.includes("\\") &&
    !p.includes("\0") &&
    !p.split("/").includes("..")
  );
}

/**
 * Runs inside the sandbox's context before the plugin: freezes the built-ins, puts reporting
 * stubs where Node's globals and the Function constructors were, and returns the two functions
 * the worker drives the plugin with. `host` (the worker's function) is only ever called with
 * strings and numbers, and never handed to plugin code: the plugin only ever sees objects made
 * in its own context.
 */
const BOOTSTRAP = String.raw`(function (host) {
  "use strict";
  const g = globalThis;
  const send = host;
  const blocked = (what) => {
    send("violation", 0, String(what));
    return new Error("blocked: " + what + " is not allowed in a scanner plugin");
  };
  // Code from strings: the constructors every function reaches, and eval.
  const compileStub = function () { throw blocked("compile code from a string (eval or Function)"); };
  for (const f of [function () {}, async function () {}, function* () {}, async function* () {}])
    Object.defineProperty(Object.getPrototypeOf(f), "constructor", { value: compileStub });
  Object.defineProperty(g, "Function", { value: compileStub });
  Object.defineProperty(g, "eval", { value: compileStub });
  // Node's way out of the sandbox, if it were there: reported when touched.
  for (const name of ["require", "process", "module", "exports", "Buffer", "fetch", "XMLHttpRequest",
    "WebSocket", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "WebAssembly",
    "SharedArrayBuffer", "Atomics"]) {
    Object.defineProperty(g, name, { get() { throw blocked("use " + name); }, configurable: false });
  }
  // The same commit must read the same (ADR 0074): no clock, no randomness.
  Object.defineProperty(g, "Date", { get() { throw blocked("use Date (the scan's time is ctx.scannedAt)"); }, configurable: false });
  Object.defineProperty(Math, "random", { value: function () { throw blocked("use Math.random"); } });
  const noop = () => undefined;
  Object.defineProperty(g, "console", { value: Object.freeze({ log: noop, info: noop, warn: noop, error: noop, debug: noop }) });
  // Freeze what the plugin and this bootstrap share, so neither can be changed under the other.
  const seen = new Set();
  const freeze = (o) => {
    if ((typeof o !== "object" && typeof o !== "function") || o === null || seen.has(o)) return;
    seen.add(o);
    Object.freeze(o);
    for (const k of Reflect.ownKeys(o)) {
      const d = Object.getOwnPropertyDescriptor(o, k);
      if (d && "value" in d) freeze(d.value);
    }
    freeze(Object.getPrototypeOf(o));
  };
  for (const k of Reflect.ownKeys(g)) {
    const d = Object.getOwnPropertyDescriptor(g, k);
    if (d && "value" in d) freeze(d.value);
  }
  for (const f of [function () {}, async function () {}, function* () {}, async function* () {}])
    freeze(Object.getPrototypeOf(f));
  for (const f of [function* () {}, async function* () {}]) freeze(Object.getPrototypeOf(f()));
  freeze(Object.getPrototypeOf([][Symbol.iterator]()));
  freeze(Object.getPrototypeOf(new Map()[Symbol.iterator]()));
  freeze(Object.getPrototypeOf(new Set()[Symbol.iterator]()));
  freeze(Object.getPrototypeOf(""[Symbol.iterator]()));
  freeze(Object.getPrototypeOf(/x/[Symbol.matchAll]("")));
  Object.freeze(g);

  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const pending = new Map();
  let next = 0;
  const ask = (op, arg) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      send(op, id, arg);
    });
  function answer(id, ok, text) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(parse(text));
    else p.reject(new Error(text));
  }
  async function drive(x, input) {
    const data = parse(input);
    if (!x || typeof x !== "object" || typeof x.scan !== "function")
      throw new Error("the entry file's default export isn't an extractor (id, version, claims, scan)");
    send("meta", 0, stringify({ id: String(x.id), version: String(x.version) }));
    const repo = Object.freeze({
      name: data.repo.name,
      commit: data.repo.commit,
      listFiles: async function* (globs) {
        const list = await ask("list", stringify(Array.from(globs, (s) => String(s))));
        for (const p of list) yield p;
      },
      readText: (path) => ask("read", String(path)),
    });
    const ctx = Object.freeze({
      ...data.ctx,
      warn: (message, path) =>
        send("warn", 0, stringify(path === undefined ? { message: String(message) } : { message: String(message), path: String(path) })),
    });
    for await (const r of x.scan(repo, ctx)) send("record", 0, stringify(r));
  }
  function run(x, input) {
    drive(x, input).then(
      () => send("done", 0, ""),
      (e) => send("error", 0, String(e && e.message !== undefined ? e.message : e)),
    );
  }
  return Object.freeze({ answer, run });
})`;

/**
 * The worker's own code (CommonJS, run with `eval: true`). It has Node, the plugin doesn't:
 * this code compiles the plugin in a fresh context and relays its requests to the host.
 */
const WORKER = String.raw`"use strict";
const vm = require("node:vm");
const { parentPort, workerData } = require("node:worker_threads");
const { source, identifier, input, bootstrap } = workerData;
const post = (m) => parentPort.postMessage(m);
const context = vm.createContext(
  vm.constants && vm.constants.DONT_CONTEXTIFY !== undefined ? vm.constants.DONT_CONTEXTIFY : {},
  { name: identifier, codeGeneration: { strings: false, wasm: false } },
);
// Errors thrown into plugin code are made in its context, never the worker's.
const makeError = vm.runInContext("(m) => new Error(m)", context);
let bridge;
const host = (op, id, arg) => {
  try {
    if (typeof op !== "string" || typeof id !== "number" || typeof arg !== "string") return;
    post({ t: op, id, arg });
  } catch {
    // Never throw a worker error into the plugin's context.
  }
};
parentPort.on("message", (m) => {
  if (m && m.t === "answer") bridge.answer(m.id, m.ok, m.text);
});
(async () => {
  try {
    bridge = vm.runInContext(bootstrap, context)(host);
    const refuse = (spec) => {
      post({ t: "violation", id: 0, arg: "import " + String(spec) });
      throw makeError("blocked: import " + String(spec) + " is not allowed in a scanner plugin");
    };
    const mod = new vm.SourceTextModule(source, {
      context,
      identifier,
      importModuleDynamically: (spec) => refuse(spec),
    });
    await mod.link((spec) => refuse(spec));
    await mod.evaluate();
    bridge.run(mod.namespace.default, input);
  } catch (e) {
    post({ t: "error", id: 0, arg: String(e && e.message !== undefined ? e.message : e) });
  }
})();
`;

/** The scan context as data the sandbox can take: everything but `warn`. */
function contextData(ctx: ScanContext) {
  return {
    dialects: [...ctx.dialects],
    scannedAt: ctx.scannedAt,
    ...(ctx.component !== undefined ? { component: ctx.component } : {}),
    ...(ctx.system !== undefined ? { system: ctx.system } : {}),
    ...(ctx.repoType !== undefined ? { repoType: ctx.repoType } : {}),
    ...(ctx.modules ? { modules: ctx.modules } : {}),
    ...(ctx.frameworks ? { frameworks: ctx.frameworks } : {}),
  };
}

/** Run the plugin once over the repo in a fresh worker; resolves with its records. */
function runInWorker(
  p: SandboxPlugin,
  repo: RepoHandle,
  ctx: ScanContext,
): Promise<CatalogRecord[]> {
  const records: CatalogRecord[] = [];
  const emits = new Set(p.emits);
  const memoryMb = p.limits.memoryMb;
  return new Promise<CatalogRecord[]>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(WORKER, {
      eval: true,
      workerData: {
        source: p.source,
        identifier: `plugin:${p.id}/${p.entry ?? "index.js"}`,
        input: JSON.stringify({
          repo: { name: repo.name, commit: repo.commit },
          ctx: contextData(ctx),
        }),
        bootstrap: BOOTSTRAP,
      },
      execArgv: ["--experimental-vm-modules", "--no-warnings"],
      argv: [],
      env: {},
      stdout: true,
      stderr: true,
      stdin: false,
      trackUnmanagedFds: true,
      resourceLimits: {
        maxOldGenerationSizeMb: memoryMb,
        maxYoungGenerationSizeMb: Math.max(4, Math.min(16, Math.floor(memoryMb / 4))),
        codeRangeSizeMb: 16,
        stackSizeMb: 4,
      },
      name: `atticus-plugin-${p.id}`,
    });
    // Its output goes nowhere: a plugin talks to the scan only through its records and warnings.
    worker.stdout.resume();
    worker.stderr.resume();
    const finish = (err?: PluginRunError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (err) reject(err);
      else resolve(records);
    };
    const timer = setTimeout(
      () =>
        finish(
          new PluginRunError(`stopped after ${p.limits.timeoutMs} ms, its time limit`, "timeout"),
        ),
      p.limits.timeoutMs,
    );
    const outside = (what: string, path: string) =>
      finish(
        new PluginRunError(
          `blocked: tried to ${what} ${JSON.stringify(path)}, which is outside the repo`,
          "blocked",
        ),
      );
    const answer = (id: number, ok: boolean, text: string) => {
      if (!settled) worker.postMessage({ t: "answer", id, ok, text });
    };
    worker.on("message", (m: { t: string; id: number; arg: string }) => {
      if (settled) return;
      void (async () => {
        switch (m.t) {
          case "list": {
            const globs = JSON.parse(m.arg) as string[];
            const bad = globs.find((g) => typeof g !== "string" || !insideRepo(g));
            if (bad !== undefined) return outside("list", String(bad));
            try {
              const out: string[] = [];
              for await (const f of repo.listFiles(globs)) out.push(f);
              answer(m.id, true, JSON.stringify(out));
            } catch (e) {
              answer(m.id, false, (e as Error).message);
            }
            return;
          }
          case "read": {
            if (!insideRepo(m.arg)) return outside("read", m.arg);
            try {
              answer(m.id, true, JSON.stringify(await repo.readText(m.arg)));
            } catch (e) {
              answer(m.id, false, (e as Error).message);
            }
            return;
          }
          case "meta": {
            const meta = JSON.parse(m.arg) as { id: string; version: string };
            if (meta.id !== p.id || meta.version !== p.version)
              finish(
                new PluginRunError(
                  `the entry file exports ${meta.id} ${meta.version}, but its manifest says ${p.id} ${p.version}`,
                  "invalid",
                ),
              );
            return;
          }
          case "record": {
            const r = JSON.parse(m.arg) as { kind?: unknown };
            if (!emits.has(String(r?.kind)))
              return finish(
                new PluginRunError(
                  `emitted a ${String(r?.kind)} record; its manifest allows ${[...emits].join(", ")}`,
                  "invalid",
                ),
              );
            if (records.length >= MAX_RECORDS)
              return finish(
                new PluginRunError(`emitted more than ${MAX_RECORDS} records`, "invalid"),
              );
            records.push(r as CatalogRecord);
            return;
          }
          case "warn": {
            const w = JSON.parse(m.arg) as { message: string; path?: string };
            ctx.warn(w.message, w.path);
            return;
          }
          case "violation":
            return finish(new PluginRunError(`blocked: tried to ${m.arg}`, "blocked"));
          case "error":
            return finish(new PluginRunError(`failed: ${m.arg}`, "failed"));
          case "done":
            return finish();
        }
      })().catch((e: Error) => finish(new PluginRunError(`failed: ${e.message}`, "failed")));
    });
    worker.on("error", (e: Error & { code?: string }) =>
      finish(
        e.code === "ERR_WORKER_OUT_OF_MEMORY"
          ? new PluginRunError(
              `stopped: it used more than its ${memoryMb} MB memory limit`,
              "memory",
            )
          : new PluginRunError(`failed: ${e.message}`, "failed"),
      ),
    );
    worker.on("exit", (code) =>
      finish(new PluginRunError(`stopped before it finished (exit code ${code})`, "failed")),
    );
  });
}

/**
 * An org-pack plugin as an Extractor: each scan runs it in a fresh sandbox. Its id is
 * `plugin-<id>`; the scan validates what it returns against C1 like any extractor's.
 */
export function sandboxedExtractor(p: SandboxPlugin): Extractor {
  return {
    id: `${PLUGIN_EXTRACTOR_PREFIX}${p.id}`,
    version: p.version,
    // What the plugin reads is up to it, through the handle: the run is never skipped.
    claims: ["**/*"],
    async *scan(repo, ctx) {
      for (const r of await runInWorker(p, repo, ctx)) yield r;
    },
  };
}
