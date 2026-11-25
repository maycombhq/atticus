import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAndWrite, buildPhases, type BuildAndWrite } from "@maycombhq/scanner";
import { catalogDirOf, hashCacheHooks, settleAfterResult } from "@maycombhq/core";
import { writeFactsHooks, writeFactsIntoCatalog } from "../src/map-render-commands.js";
import { bigRepoId, makeBigEstate, writeBigRepo } from "./big-estate.js";

/**
 * Item 11 of docs/plan/ai-first.md: the two slow steps of each Apply (one repo's
 * `verify --write`), the guards' hash of every record file and the intake of inputs/, on a
 * generated estate of 60 repos (big-estate.ts with small repos: 45 services and 15 gateway
 * proxies, about 13,500 record files, the owner's 41 repos had 12,846) and an inputs/ folder of
 * 30 partner specs and 30 diagrams naming its systems. Invented names only.
 *
 * The budget is the wall-clock seconds of those two steps of a steady Apply (buildPhases'
 * clock): about three times what this build machine measured after the change (0.9 to 1 s, see
 * docs/plan/v33-notes/item11.md), for a slow Windows runner. The intake as it was (every name
 * and spec operation looked up by reading every record) took 2.3 to 2.6 s of it here. The count
 * of files the hash opened is the sharp check: on any platform, a steady Apply opens only the
 * files the last one wrote (hash-cache.ts), so a runner whose kept hashes don't hold fails it.
 * ATTICUS_APPLY_REPOS gives another size.
 */
const REPOS = Number(process.env.ATTICUS_APPLY_REPOS ?? 60);
/** Services; the rest are gateway proxies fronting some of them. */
const SERVICES = Math.round((REPOS * 3) / 4);
const BUDGET_S = 3;
const SPECS = 30;
const OPS = 120;
const DIAGRAMS = 30;
const BOXES = 200;

let dir: string;
let root: string;
let recordFiles = 0;
let records: string[] = [];
let options: Awaited<ReturnType<typeof makeBigEstate>>["options"];
const quiet = { out: () => undefined, err: () => undefined };
const repo = bigRepoId(1);

/** Partner specs titled by a system (some by none), and diagrams whose boxes name systems. */
async function writeInputs(at: string) {
  const nouns = ["account", "payment", "ledger", "invoice", "transfer"];
  for (let s = 0; s < SPECS; s++) {
    const title =
      s % 5 === 4 ? `Northwind Partner ${s}` : `Forge Svc ${String(s).padStart(2, "0")}`;
    const paths = Array.from({ length: OPS }, (_, k) => [
      `  /v1/${nouns[k % 5]}s/{id}/item-${k}:`,
      "    get:",
      `      operationId: get${k}`,
      '      responses: { "200": { description: ok } }',
    ]).flat();
    const text = ["openapi: 3.0.0", "info:", `  title: ${title}`, "  version: 1.0.0", "paths:"];
    await mkdir(join(at, "partner-specs"), { recursive: true });
    await writeFile(
      join(at, "partner-specs", `spec-${s}.yaml`),
      [...text, ...paths, ""].join("\n"),
    );
  }
  for (let d = 0; d < DIAGRAMS; d++) {
    const cells = Array.from({ length: BOXES }, (_, k) => {
      const n = (d * 7 + k) % (SERVICES + 10);
      const label = n < SERVICES ? `Forge Svc ${String(n).padStart(2, "0")}` : `Outside Box ${n}`;
      return `        <mxCell id="c${k}" value="${label}" style="rounded=1;" vertex="1" parent="1"/>`;
    });
    const edges = Array.from(
      { length: BOXES - 1 },
      (_, k) =>
        `        <mxCell id="e${k}" value="" edge="1" source="c${k}" target="c${k + 1}" parent="1"/>`,
    );
    const xml = [
      '<mxfile host="drawio">',
      `  <diagram id="d${d}" name="Forge view ${d}">`,
      "    <mxGraphModel>",
      "      <root>",
      '        <mxCell id="0"/>',
      '        <mxCell id="1" parent="0"/>',
      ...cells,
      ...edges,
      "      </root>",
      "    </mxGraphModel>",
      "  </diagram>",
      "</mxfile>",
      "",
    ];
    await mkdir(join(at, "diagrams"), { recursive: true });
    await writeFile(join(at, "diagrams", `view-${d}.drawio`), xml.join("\n"));
  }
}

/** One Apply of repo 1 after its `edit`-th change: its guard-and-intake seconds, by phase. */
async function apply(edit: number) {
  const facts = await writeBigRepo(root, 1, options, edit, true, false);
  const phases = new Map<string, number>();
  buildPhases.on = (p, ms) => phases.set(p, (phases.get(p) ?? 0) + ms / 1000);
  const opened: number[] = [];
  hashCacheHooks.onHashed = (n) => opened.push(n);
  const t = performance.now();
  try {
    const w = await writeFactsIntoCatalog(
      root,
      repo,
      facts,
      { dir: join(root, "workspace", repo), command: `atticus verify ${repo} --write` },
      quiet,
    );
    await settleAfterResult();
    const total = (performance.now() - t) / 1000;
    const sum = (re: RegExp) =>
      [...phases].filter(([p]) => re.test(p)).reduce((a, [, s]) => a + s, 0);
    const hash = sum(/^hash: |^guards: build\.json read/);
    const intake = sum(/^build: 3 intake/);
    const line = [...phases].map(([p, s]) => `${p} ${s.toFixed(2)}`).join("; ");
    console.log(
      `apply-speed ${REPOS} repos, Apply ${edit}: ${total.toFixed(1)} s; hash ${hash.toFixed(2)} s (${opened.join(" + ")} files opened), intake ${intake.toFixed(2)} s\n  ${line}`,
    );
    return { w, hash, intake, total, opened: opened.reduce((a, n) => a + n, 0) };
  } finally {
    buildPhases.on = undefined;
    delete hashCacheHooks.onHashed;
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "atticus-apply-speed-"));
  const made = await makeBigEstate(dir, {
    repos: SERVICES,
    gateways: REPOS - SERVICES,
    entries: 40,
    calls: 25,
    tables: 6,
    settings: 40,
    checkouts: 2,
  });
  root = made.root;
  options = made.options;
  await writeInputs(join(root, "inputs"));
  const cold = await buildAndWrite(root, { command: "atticus catalog build" });
  expect(cold.guard.refused).toBeUndefined();
  const files = await readdir(join(catalogDirOf(root), "generated"), { recursive: true });
  records = files.filter((f) => f.endsWith(".yaml")).sort();
  recordFiles = records.length;
  console.log(`apply-speed ${REPOS} repos: ${recordFiles} record files`);
}, 1_200_000);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe(`each Apply on a ${REPOS}-repo estate (item 11)`, () => {
  it(`hashes the record files and takes in inputs/ in under ${BUDGET_S} s`, async () => {
    await apply(1); // fills the caches, as the first command after a build does
    const steady = await apply(2);
    expect(steady.w?.written.written).toBeGreaterThan(0);
    expect(steady.hash + steady.intake).toBeLessThan(BUDGET_S);
    // The kept hashes hold (hash-cache.ts): only the files the last Apply wrote are opened.
    expect(steady.opened).toBeLessThan(recordFiles / 100);
  }, 1_200_000);

  /** An Apply that refuses as a build does (ADR 0210 part 3 goes past hand edits by curating). */
  const strictApply = async (edit: number) => {
    const facts = await writeBigRepo(root, 1, options, edit, true, false);
    let refused: BuildAndWrite | undefined;
    writeFactsHooks.strict = true;
    try {
      const w = await writeFactsIntoCatalog(
        root,
        repo,
        facts,
        {
          dir: join(root, "workspace", repo),
          command: `atticus verify ${repo} --write`,
          onRefused: (r) => (refused = r),
        },
        quiet,
      );
      return { w, refused: refused as BuildAndWrite | undefined };
    } finally {
      delete writeFactsHooks.strict;
    }
  };
  const recordFile = (n: number) => join(catalogDirOf(root), "generated", records[n]!);

  it("still sees a hand edit of the same size with its time put back", async () => {
    const file = recordFile(500);
    const before = await stat(file);
    const text = await readFile(file, "utf8");
    // One letter for another: the same size; then the file's times as they were.
    const edited = text.replace(
      /^(id: \S*?)([a-z])/m,
      (_, a: string, c: string) => a + (c === "a" ? "b" : "a"),
    );
    expect(edited).not.toBe(text);
    expect(edited.length).toBe(text.length);
    await writeFile(file, edited);
    await utimes(file, before.atimeMs / 1000, before.mtimeMs / 1000);
    try {
      expect(Math.floor((await stat(file)).mtimeMs)).toBe(Math.floor(before.mtimeMs));
      const { refused } = await strictApply(3);
      expect(refused?.guard.refused?.reasons).toContain("hand-edits");
      expect(refused?.guard.edits.map((e) => e.path)).toEqual([
        `catalog/generated/${records[500]!.split(sep).join("/")}`,
      ]);
    } finally {
      await writeFile(file, text);
    }
  }, 600_000);

  it("doesn't take line endings changed to CRLF for a hand edit", async () => {
    const file = recordFile(600);
    await writeFile(file, (await readFile(file, "utf8")).replace(/\n/g, "\r\n"));
    const { w, refused } = await strictApply(4);
    expect(refused?.guard.refused).toBeUndefined();
    expect(w?.written.written).toBeGreaterThan(0);
  }, 600_000);
});
