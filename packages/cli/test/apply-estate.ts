import { mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildAndWrite, buildPhases, type BuildAndWrite } from "@maycombhq/scanner";
import { catalogDirOf, hashCacheHooks, settleAfterResult } from "@maycombhq/core";
import { intakeHooks } from "@maycombhq/intake";
import { nameResolverHooks } from "@maycombhq/reconcile";
import { writeFactsHooks, writeFactsIntoCatalog } from "../src/map-render-commands.js";
import { bigRepoId, makeBigEstate, writeBigRepo } from "./big-estate.js";

/**
 * Item 11 of docs/plan/ai-first.md: an estate for the two slow steps of an Apply, the guards'
 * hash and the intake (apply-speed.test.ts at 60 repos, apply-counts.test.ts small). big-estate.ts
 * with small repos (three in four services, the rest gateway proxies), and an inputs/ folder of
 * partner specs and draw.io diagrams naming its services, its times an hour back (so nothing in
 * it is racily new). Invented names only.
 */
export interface ApplyEstate {
  root: string;
  options: Awaited<ReturnType<typeof makeBigEstate>>["options"];
  /** The record files under catalog/generated after the cold build, by path under it, sorted. */
  records: string[];
}

export async function makeApplyEstate(
  dir: string,
  repos: number,
  inputs: { specs: number; ops: number; diagrams: number; boxes: number },
): Promise<ApplyEstate> {
  const services = Math.round((repos * 3) / 4);
  const made = await makeBigEstate(dir, {
    repos: services,
    gateways: repos - services,
    entries: 40,
    calls: 25,
    tables: 6,
    settings: 40,
    checkouts: 2,
  });
  const at = join(made.root, "inputs");
  const nouns = ["account", "payment", "ledger", "invoice", "transfer"];
  const svc = (n: number) => `Forge Svc ${String(n).padStart(2, "0")}`;
  const written: string[] = [];
  const put = async (rel: string, text: string) => {
    await mkdir(join(at, rel, ".."), { recursive: true });
    await writeFile(join(at, rel), text);
    written.push(join(at, rel));
  };
  for (let s = 0; s < inputs.specs; s++) {
    const title = s % 5 === 4 ? `Northwind Partner ${s}` : svc(s % services);
    const paths = Array.from({ length: inputs.ops }, (_, k) => [
      `  /v1/${nouns[k % 5]}s/{id}/item-${k}:`,
      "    get:",
      `      operationId: get${k}`,
      '      responses: { "200": { description: ok } }',
    ]).flat();
    const head = ["openapi: 3.0.0", "info:", `  title: ${title}`, "  version: 1.0.0", "paths:"];
    await put(`partner-specs/spec-${s}.yaml`, [...head, ...paths, ""].join("\n"));
  }
  for (let d = 0; d < inputs.diagrams; d++) {
    const cell = (k: number) => {
      const n = (d * 7 + k) % (services + 10);
      const label = n < services ? svc(n) : `Outside Box ${n}`;
      return `        <mxCell id="c${k}" value="${label}" style="rounded=1;" vertex="1" parent="1"/>`;
    };
    const edge = (k: number) =>
      `        <mxCell id="e${k}" value="" edge="1" source="c${k}" target="c${k + 1}" parent="1"/>`;
    const xml = [
      '<mxfile host="drawio">',
      `  <diagram id="d${d}" name="Forge view ${d}">`,
      "    <mxGraphModel>",
      "      <root>",
      '        <mxCell id="0"/>',
      '        <mxCell id="1" parent="0"/>',
      ...Array.from({ length: inputs.boxes }, (_, k) => cell(k)),
      ...Array.from({ length: inputs.boxes - 1 }, (_, k) => edge(k)),
      "      </root>",
      "    </mxGraphModel>",
      "  </diagram>",
      "</mxfile>",
      "",
    ];
    await put(`diagrams/view-${d}.drawio`, xml.join("\n"));
  }
  const old = new Date(Date.now() - 3_600_000);
  for (const p of written) await utimes(p, old, old);
  const cold = await buildAndWrite(made.root, { command: "atticus catalog build" });
  if (cold.guard.refused) throw new Error("the cold build was refused");
  const files = await readdir(join(catalogDirOf(made.root), "generated"), { recursive: true });
  return {
    root: made.root,
    options: made.options,
    records: files.filter((f) => f.endsWith(".yaml")).sort(),
  };
}

const quiet = { out: () => undefined, err: () => undefined };
const REPO = bigRepoId(1);

/** What one Apply of repo 1 did: its phases' seconds, files opened, inputs read, catalog reads. */
export interface Applied {
  written?: { written: number; unchanged: number; removed: number };
  refused?: BuildAndWrite;
  phases: Map<string, number>;
  hash: number;
  intake: number;
  total: number;
  /** Record files the guards' hash opened. */
  opened: number;
  /** Files of inputs/ intake read again, and its reads of the catalog for names. */
  inputsRead: string[];
  catalogReads: number;
  /** Intakes run (the build's, by its phase). */
  intakes: number;
}

/**
 * One Apply of repo 1 after its `edit`-th change, as `verify <repo> --write` and the app's Apply
 * run it. `strict`: it refuses as a build does (ADR 0210 part 3 goes past hand edits by curating).
 */
export async function applyOnce(
  e: ApplyEstate,
  edit: number,
  o: { strict?: boolean } = {},
): Promise<Applied> {
  const facts = await writeBigRepo(e.root, 1, e.options, edit, true, false);
  const phases = new Map<string, number>();
  const opened: number[] = [];
  const inputsRead: string[] = [];
  let catalogReads = 0;
  let intakes = 0;
  let refused: BuildAndWrite | undefined;
  buildPhases.on = (p, ms) => {
    phases.set(p, (phases.get(p) ?? 0) + ms / 1000);
    if (p === "intake: names and readers") intakes++;
  };
  hashCacheHooks.onHashed = (n) => opened.push(n);
  intakeHooks.onRead = (p) => inputsRead.push(p);
  nameResolverHooks.onCatalogRead = () => catalogReads++;
  if (o.strict) writeFactsHooks.strict = true;
  const t = performance.now();
  try {
    const w = await writeFactsIntoCatalog(
      e.root,
      REPO,
      facts,
      {
        dir: join(e.root, "workspace", REPO),
        command: `atticus verify ${REPO} --write`,
        onRefused: (r) => (refused = r),
      },
      quiet,
    );
    await settleAfterResult();
    const sum = (re: RegExp) =>
      [...phases].filter(([p]) => re.test(p)).reduce((a, [, s]) => a + s, 0);
    return {
      ...(w ? { written: w.written } : {}),
      ...(refused ? { refused } : {}),
      phases,
      hash: sum(/^hash: |^guards: build\.json read/),
      intake: sum(/^build: 3 intake/),
      total: (performance.now() - t) / 1000,
      opened: opened.reduce((a, n) => a + n, 0),
      inputsRead,
      catalogReads,
      intakes,
    };
  } finally {
    delete buildPhases.on;
    delete hashCacheHooks.onHashed;
    delete intakeHooks.onRead;
    delete nameResolverHooks.onCatalogRead;
    delete writeFactsHooks.strict;
  }
}
