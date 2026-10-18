import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseRecord, type CatalogRecord } from "@maycombhq/core";
import { fsRepo, scanRepo, type Extractor, type Ingestor, type ScanContext } from "@maycombhq/sdk";
import { guarded } from "./guard.js";
import { Results, type ConformanceReport } from "./report.js";

/**
 * Conformance of a plugin module (C4, ADR 0016): every extractor or ingestor it exports has
 * the contract's shape; it runs over a sample repo (or input files) with the network blocked;
 * everything it emits is a valid C1 record; and two runs at two different clock times give
 * byte-identical output (deterministic, no clock, ADR 0007).
 */

const SAMPLE = fileURLToPath(new URL("../sample", import.meta.url));
const SHA = "0".repeat(40);
const T1 = "2026-01-01T00:00:00Z";
const T2 = "2031-06-15T12:30:00Z";

const isExtractor = (v: unknown): v is Extractor =>
  !!v && typeof v === "object" && typeof (v as Extractor).scan === "function";
const isIngestor = (v: unknown): v is Ingestor =>
  !!v &&
  typeof v === "object" &&
  typeof (v as Ingestor).sniff === "function" &&
  typeof (v as Ingestor).ingest === "function";

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    for (const e of (await readdir(d, { withFileTypes: true }).catch(() => [])).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(dir);
  return out;
}

/**
 * Both runs get the same scan time (a plugin may use the scan context's timestamp) and a
 * different clock, so any use of the clock shows as a difference.
 */
/** Strip what the runner stamps on evidence, so two runs compare on the plugin's own output. */
function own(records: CatalogRecord[]): unknown[] {
  return records.map((r) => ({
    ...r,
    evidence: r.evidence.map((e) => {
      const { scannedAt: _s, commit: _c, extractor: _x, ...rest } = e;
      return rest;
    }),
  }));
}

export interface PluginOptions {
  /** A repo folder for extractors to scan; default: the suite's sample repo. */
  fixture?: string;
  /** Input files for ingestors; default: the suite's sample inputs. */
  inputs?: string[];
}

export async function checkPlugin(
  module: string,
  o: PluginOptions = {},
): Promise<ConformanceReport> {
  const res = new Results();
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(module).href)) as Record<string, unknown>;
  } catch (e) {
    res.fail("plugin.load", `Can't load this module: ${(e as Error).message}`);
    return res.report("plugin", module);
  }
  const exported = [...new Set(Object.values(mod).flatMap((v) => (Array.isArray(v) ? v : [v])))];
  const extractors = exported.filter(isExtractor);
  const ingestors = exported.filter(isIngestor);
  if (extractors.length + ingestors.length === 0) {
    res.fail(
      "plugin.exports",
      "The module exports no extractor (scan) and no ingestor (sniff and ingest).",
    );
    return res.report("plugin", module);
  }
  res.pass(
    "plugin.exports",
    `Found ${[...extractors.map((x) => `extractor ${x.id}`), ...ingestors.map((x) => `ingestor ${x.id}`)].join(", ")}.`,
  );
  for (const x of extractors) await checkExtractor(x, o.fixture ?? join(SAMPLE, "repo"), res);
  for (const x of ingestors)
    await checkIngestor(x, o.inputs ?? (await files(join(SAMPLE, "inputs"))), res);
  return res.report("plugin", module);
}

function shape(p: { id?: unknown; version?: unknown }, what: string, res: Results): boolean {
  let ok = true;
  if (typeof p.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(p.id)) {
    res.fail("plugin.shape", `${what}: id ${JSON.stringify(p.id)} must be a lowercase slug.`);
    ok = false;
  }
  if (typeof p.version !== "string" || !/^\d+\.\d+\.\d+(-[0-9a-z.-]+)?$/i.test(p.version)) {
    res.fail("plugin.shape", `${what}: version ${JSON.stringify(p.version)} must be semver.`);
    ok = false;
  }
  return ok;
}

async function checkExtractor(x: Extractor, fixture: string, res: Results) {
  const name = `extractor ${String(x.id)}`;
  let ok = shape(x, name, res);
  if (
    !Array.isArray(x.claims) ||
    x.claims.length === 0 ||
    !x.claims.every((c) => typeof c === "string")
  ) {
    res.fail("plugin.shape", `${name}: claims must be a non-empty list of file globs.`);
    ok = false;
  }
  if (ok) res.pass("plugin.shape", `${name} ${x.version} has an id, a semver version and claims.`);
  if (!(await stat(fixture).catch(() => undefined))?.isDirectory()) {
    res.fail("plugin.run", `${name}: no repo folder at ${fixture}.`);
    return;
  }
  const once = (at: string) =>
    guarded(
      () =>
        scanRepo({
          repo: fsRepo(basename(fixture), fixture, SHA),
          extractors: [x],
          scannedAt: T1,
          repoInfo: { component: "sample", system: "sample" },
        }),
      { fixedTime: at },
    );
  const a = await once(T1);
  const b = await once(T2);
  report(name, res, a, b, (s) => {
    const failed = s.runs.filter((r) => r.status === "failed");
    return {
      records: s.records,
      rejected: s.rejected.map((r) => r.issues.map((i) => `${i.path}: ${i.message}`).join("; ")),
      error: failed.map((r) => r.error).join("; ") || undefined,
    };
  });
}

async function checkIngestor(x: Ingestor, inputs: string[], res: Results) {
  const name = `ingestor ${String(x.id)}`;
  if (shape(x, name, res))
    res.pass("plugin.shape", `${name} ${x.version} has an id, a semver version, sniff and ingest.`);
  const once = (at: string) =>
    guarded(
      async () => {
        const records: CatalogRecord[] = [];
        const rejected: string[] = [];
        for (const file of inputs) {
          const content = new Uint8Array(await readFile(file));
          const score = x.sniff(basename(file), content.subarray(0, 4096));
          if (typeof score !== "number" || score < 0 || score > 1) {
            rejected.push(
              `${basename(file)}: sniff returned ${JSON.stringify(score)}, not a number from 0 to 1`,
            );
            continue;
          }
          if (score === 0) continue;
          const ctx: ScanContext = { dialects: [], scannedAt: T1, warn: () => undefined };
          for await (const r of x.ingest(basename(file), content, ctx)) {
            const p = parseRecord(r);
            if (p.ok) records.push(p.record);
            else
              rejected.push(
                `${relative(process.cwd(), file).split(sep).join("/")}: ${p.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
              );
          }
        }
        return { records, rejected };
      },
      { fixedTime: at },
    );
  const a = await once(T1);
  const b = await once(T2);
  report(name, res, a, b, (s) => ({ records: s.records, rejected: s.rejected }));
}

function report<S>(
  name: string,
  res: Results,
  a: { value?: S; error?: unknown; attempts: string[] },
  b: { value?: S; error?: unknown; attempts: string[] },
  read: (s: S) => { records: CatalogRecord[]; rejected: string[]; error?: string },
) {
  const attempts = [...new Set([...a.attempts, ...b.attempts])];
  if (attempts.length > 0)
    res.fail("plugin.network", `${name} tried to reach the network: ${attempts.join(", ")}.`);
  else res.pass("plugin.network", `${name} made no network call.`);
  const ra = a.value ? read(a.value) : undefined;
  const rb = b.value ? read(b.value) : undefined;
  const err = a.error ?? b.error;
  if (err || ra?.error || !ra || !rb) {
    res.fail(
      "plugin.run",
      `${name} failed: ${err instanceof Error ? err.message : String(err ?? ra?.error ?? rb?.error)}`,
    );
    return;
  }
  res.pass(
    "plugin.run",
    `${name} ran and emitted ${ra.records.length} record${ra.records.length === 1 ? "" : "s"}.`,
  );
  for (const r of ra.rejected)
    res.fail("plugin.records", `${name} emitted an invalid record: ${r}`);
  if (ra.rejected.length === 0)
    res.pass("plugin.records", `Every record ${name} emitted is valid C1.`);
  if (JSON.stringify(own(ra.records)) !== JSON.stringify(own(rb.records)))
    res.fail(
      "plugin.determinism",
      `${name} gave different output on two runs (at two clock times): it must read files only, with no clock or randomness.`,
    );
  else
    res.pass("plugin.determinism", `${name} gave identical output on two runs at two clock times.`);
}
