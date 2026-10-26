import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bundledOpenSpecBin, createOpenSpec, openspecEnv } from "./adapter.js";
import { readStore, type StoreView } from "./stores.js";

/**
 * Feature detection (ADR 0006 addendum, 2026-10-25, "Compatibility"): what the installed OpenSpec
 * offers, found out once per CLI script from its own help, never assumed from its version. Atticus
 * uses OpenSpec's command for a feature when it has one and falls back to its own reading
 * otherwise, and says which path ran. The beta and experimental features of 1.14.0: `store`
 * (setup, register, list, doctor), `workset`, `context`, `doctor`, `schema` and `schemas`.
 */

/** The features Atticus looks for, each with the command that shows it. */
export const BETA_FEATURES = [
  "store",
  "store list",
  "store doctor",
  "workset",
  "context",
  "doctor",
  "schema",
  "schemas",
] as const;
export type BetaFeature = (typeof BETA_FEATURES)[number];

export interface OpenSpecFeatures {
  /** The top-level commands its help lists. */
  commands: string[];
  /** Each beta feature: whether it is there, and whether it prints JSON (`--json`). */
  beta: Record<BetaFeature, { present: boolean; json: boolean }>;
}

const cache = new Map<string, Promise<OpenSpecFeatures>>();

function help(bin: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [bin, ...args, "--help"],
      { env: openspecEnv(env), timeout: 30_000, windowsHide: true, encoding: "utf8" },
      (err, stdout) => done(err ? "" : stdout),
    );
  });
}

/** The command names under a help text's "Commands:" heading (`list|ls` reads as `list`). */
export function commandsIn(text: string): string[] {
  const at = text.search(/^Commands:\s*$/m);
  if (at < 0) return [];
  const out: string[] = [];
  for (const l of text.slice(at).split(/\r?\n/).slice(1)) {
    const m = /^ {2}([a-z][a-z0-9-]*)(?:\|[a-z0-9-]+)?\b/.exec(l);
    if (m) out.push(m[1]!);
  }
  return out;
}

/**
 * The installed OpenSpec's features, cached per CLI script for the process. Offline, as every
 * OpenSpec run is: no telemetry, no update check.
 */
export function openspecFeatures(
  o: { bin?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<OpenSpecFeatures> {
  const bin = o.bin ?? bundledOpenSpecBin();
  const had = cache.get(bin);
  if (had) return had;
  const p = (async () => {
    const top = commandsIn(await help(bin, [], o.env));
    const has = (c: string) => top.includes(c);
    const sub = async (c: string) => (has(c) ? await help(bin, [c], o.env) : "");
    const [store, ctx, doctor, workset] = await Promise.all([
      sub("store"),
      sub("context"),
      sub("doctor"),
      sub("workset"),
    ]);
    const storeCmds = commandsIn(store);
    const storeList = storeCmds.includes("list") ? await help(bin, ["store", "list"], o.env) : "";
    const storeDoctor = storeCmds.includes("doctor")
      ? await help(bin, ["store", "doctor"], o.env)
      : "";
    const json = (t: string) => /--json\b/.test(t);
    const beta: OpenSpecFeatures["beta"] = {
      store: { present: has("store"), json: false },
      "store list": { present: storeCmds.includes("list"), json: json(storeList) },
      "store doctor": { present: storeCmds.includes("doctor"), json: json(storeDoctor) },
      workset: { present: has("workset"), json: json(workset) },
      context: { present: has("context"), json: json(ctx) },
      doctor: { present: has("doctor"), json: json(doctor) },
      schema: { present: has("schema"), json: false },
      schemas: { present: has("schemas"), json: true },
    };
    return { commands: top, beta };
  })();
  cache.set(bin, p);
  return p;
}

/** A store as Atticus reads it, and which path read it. */
export interface StoreRead extends StoreView {
  /** `openspec`: OpenSpec's `list --json` (changes, task counts, specs) ran in the store; `files`: Atticus read its files. */
  via: "openspec" | "files";
}

/**
 * Read a store (ADR 0126) through OpenSpec where it can: `openspec list --json` and
 * `list --specs --json` run in the store's folder give its open changes with their task counts
 * and its specs; the change titles and spec purposes come from `show`. The file reading of
 * `readStore` is the fallback (an OpenSpec that can't run there), and the store.yaml marker is
 * read from the file either way (OpenSpec has no command that prints it).
 */
export async function readStoreVia(
  dir: string,
  o: { bin?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<StoreRead> {
  const files = await readStore(dir);
  // Nothing for OpenSpec to list: the folder or its openspec/ isn't there (readStore said so).
  if (!existsSync(join(dir, "openspec"))) return { ...files, via: "files" };
  try {
    const os = createOpenSpec({
      root: dir,
      ...(o.bin ? { bin: o.bin } : {}),
      ...(o.env ? { env: o.env } : {}),
    });
    const changes = await os.listChanges();
    const specs = await os.listSpecs();
    return {
      ...files,
      changes: await Promise.all(
        changes.map(async (c) => {
          const title = await os
            .showChange(c.name)
            .then((d) => d.title)
            .catch(() => undefined);
          return {
            id: c.name,
            ...(title && title !== c.name ? { title } : {}),
            ...(c.totalTasks ? { tasks: { done: c.completedTasks, total: c.totalTasks } } : {}),
            dir:
              files.changes.find((x) => x.id === c.name)?.dir ??
              join(dir, "openspec", "changes", c.name),
          };
        }),
      ),
      specs: specs.map((s) => {
        const f = files.specs.find((x) => x.id === s.id);
        return {
          id: s.id,
          ...(f?.purpose ? { purpose: f.purpose } : {}),
          file: f?.file ?? join(dir, "openspec", "specs", s.id, "spec.md"),
        };
      }),
      via: "openspec",
    };
  } catch (e) {
    return {
      ...files,
      notes: [
        ...files.notes,
        `read from its files: openspec list couldn't run (${(e as Error).message.split("\n")[0]})`,
      ],
      via: "files",
    };
  }
}
