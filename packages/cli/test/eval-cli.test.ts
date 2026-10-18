import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { MockRuntime, ReplayRuntime } from "@maycombhq/ai";
import { readRecordings } from "@maycombhq/evals";
import { defencesScan, evalReport, evalRun } from "../src/eval-commands.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const RED = join(HERE, "../../ai/test/fixtures/red-team");
const T = 300_000;
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 9, 20, 9, 0, tick++));

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

async function metarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-eval-cli-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  return root;
}

/** A minimal stored ZIP (Office files are ZIPs), enough for the readers. */
function zip(entries: { name: string; data: string }[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const body = Buffer.from(e.data, "utf8");
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(body) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

describe("atticus eval", () => {
  it(
    "runs every dataset in mock and replay mode, saves the report and the AI-quality summary",
    async () => {
      const root = await metarepo();
      let c = capture();
      expect(await evalReport(root, {}, c.io)).toBe(0);
      expect(c.out).toEqual([
        "No eval runs yet. Run atticus eval run (mock or replay), or --mode live with a configured model.",
      ]);
      c = capture();
      expect(await evalRun(root, { mode: "mock" }, c.io, { now: clock })).toBe(0);
      expect(c.err).toEqual([]);
      expect(c.out[0]).toMatch(/^Eval run eval-\d{14}-mock \(mock, 1 run per case\):$/);
      expect(c.out).toContain("feature-namer        2      2       2     100%");
      expect(c.out.at(-1)).toMatch(/^Saved \.evals\/runs\/eval-\d{14}-mock\/report\.json\.$/);
      c = capture();
      expect(await evalRun(root, { mode: "replay", json: true }, c.io, { now: clock })).toBe(0);
      const replay = JSON.parse(c.out.join("\n")) as {
        report: { results: { pass: boolean }[]; skipped: unknown[] };
      };
      expect(replay.report.results.every((r) => r.pass)).toBe(true);
      expect(replay.report.skipped).toHaveLength(4);
      c = capture();
      expect(await evalReport(root, { json: true }, c.io)).toBe(0);
      const q = JSON.parse(c.out.join("\n")) as {
        agents: { agent: string; mode: string; passRate: number }[];
      };
      expect(q.agents.find((a) => a.agent === "story-writer")).toMatchObject({
        mode: "replay",
        passRate: 1,
      });
      expect(q.agents.find((a) => a.agent === "dialect-writer")).toMatchObject({
        mode: "mock",
        passRate: 1,
      });
    },
    T,
  );

  it(
    "measures the live bar over five runs, and reports a regression against the previous run",
    async () => {
      const root = await metarepo();
      // A stand-in for a live model (tests never call one): the recorded answer, or a broken one
      // on two runs of every three, so the bar is missed at 2 of 5.
      const recordings = readRecordings(join(HERE, "../../features/test/fixtures/recordings"));
      let n = 0;
      const good = () => new ReplayRuntime(recordings);
      const flaky = () =>
        new MockRuntime(() => (n++ % 3 === 0 ? recordings[0]!.output : "features: [broken"));
      let c = capture();
      expect(
        await evalRun(root, { mode: "live", agent: "feature-namer", runs: 5 }, c.io, {
          now: clock,
          liveRuntime: good,
        }),
      ).toBe(0);
      expect(c.out).toContain("Live bar (4 of 5 runs): met.");
      c = capture();
      expect(
        await evalRun(root, { mode: "live", agent: "feature-namer", runs: 5 }, c.io, {
          now: clock,
          liveRuntime: flaky,
        }),
      ).toBe(1);
      expect(c.out).toContain(
        "Live bar (4 of 5 runs): not met (feature-namer/feature-namer-forge 2 of 5).",
      );
      expect(
        c.out.some(
          (l) =>
            l.startsWith("Regressed since eval-") &&
            l.includes("feature-namer/feature-namer-forge"),
        ),
      ).toBe(true);
      c = capture();
      expect(await evalReport(root, {}, c.io)).toBe(1);
      expect(c.out.find((l) => l.startsWith("feature-namer"))).toMatch(
        /not met \(4\/5\)\s+feature-namer\/feature-namer-forge$/,
      );
    },
    T,
  );

  it("refuses live mode in CI and without a model provider, and bad options", async () => {
    const root = await metarepo();
    let c = capture();
    expect(await evalRun(root, { mode: "live" }, c.io, { env: { CI: "true" } })).toBe(2);
    expect(c.err).toEqual([
      "Live evals call a real model, so they never run in CI. Use --mode replay there.",
    ]);
    c = capture();
    expect(await evalRun(root, { mode: "live" }, c.io, { env: {} })).toBe(2);
    expect(c.err[0]).toMatch(
      /runtime\.yaml doesn't allow model mode|Live evals need a model provider/,
    );
    c = capture();
    expect(await evalRun(root, { mode: "fast" }, c.io)).toBe(2);
    expect(await evalRun(root, { runs: 0 }, c.io)).toBe(2);
    c = capture();
    expect(await evalRun(root, { agent: "nobody" }, c.io)).toBe(2);
    expect(c.err[0]).toMatch(
      /^No eval cases for nobody\. Agents with cases: architecture-critic, /,
    );
  });
});

describe("atticus defences scan", () => {
  it("scans every red-team format and says what Atticus does with each file", async () => {
    const root = await metarepo();
    await cp(RED, join(root, "inputs/red-team"), { recursive: true });
    // the Word fixture as a real .docx
    await writeFile(
      join(root, "inputs/red-team/docx/outline.docx"),
      zip([
        {
          name: "[Content_Types].xml",
          data: '<?xml version="1.0"?><Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        },
        { name: "word/document.xml", data: readFileSync(join(RED, "docx/document.xml"), "utf8") },
      ]),
    );
    const c = capture();
    expect(await defencesScan(root, "inputs/red-team", { json: true, all: true }, c.io)).toBe(1);
    const r = JSON.parse(c.out.join("\n")) as {
      files: { path: string; risk: string; action: string }[];
    };
    const risk = (p: string) => r.files.find((f) => f.path === `inputs/red-team/${p}`)?.risk;
    expect(risk("docx/outline.docx")).toBe("high");
    expect(risk("markdown/wiki-hidden-comment.md")).toBe("high");
    expect(risk("html/white-on-white.html")).toBe("high");
    expect(risk("diagram/hidden-label.drawio")).toBe("high");
    expect(risk("openapi/base64-example.yaml")).toBe("high");
    expect(risk("markdown/visible-note.md")).toBe("medium");
    expect(risk("markdown/benign-runbook.md")).toBe("low");
    expect(risk("code/CacheJanitor.java")).toBe("none");
    // prompt files are judged as prompts: only rule changes and hidden content count
    expect(risk("absorb/review.prompt.md")).toBe("none");
    expect(risk("absorb/release.prompt.md")).toBe("medium");
    expect(r.files.find((f) => f.path.endsWith("wiki-hidden-comment.md"))!.action).toBe(
      "quarantined: left out of every AI step until a person cleans it",
    );
  });

  it("prints a table and the lines that matter", async () => {
    const root = await metarepo();
    await mkdir(join(root, "inputs/inbox"), { recursive: true });
    await cp(join(RED, "markdown/zero-width.md"), join(root, "inputs/inbox/audit.md"));
    await writeFile(join(root, "inputs/inbox/clean.md"), "# Clean\n\nNothing here.\n");
    const c = capture();
    expect(await defencesScan(root, "inputs", {}, c.io)).toBe(1);
    expect(c.out[0]).toMatch(/^RISK\s+FILE\s+WHAT ATTICUS DOES\s+WHY$/);
    expect(
      c.out.some((l) => l.startsWith("  inputs/inbox/audit.md:5 override (disguised): ")),
    ).toBe(true);
    expect(c.out.at(-1)).toBe("Scanned 2 files: 1 high, 0 medium.");
    const ok = capture();
    expect(await defencesScan(root, "inputs/inbox/clean.md", {}, ok.io)).toBe(0);
    expect(ok.out).toEqual(["Scanned 1 file: 0 high, 0 medium."]);
  });
});
