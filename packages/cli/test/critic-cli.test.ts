import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ReplayRuntime } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { critic, criticStats, findingAction, findings } from "../src/critic-commands.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const FORGE_CHANGE = join(HERE, "../../../fixtures/forge-change");
const CHANGE = "add-transfer-limit";
const NOW = "2026-10-20T09:00:00Z";
const LATER = "2026-10-21T10:00:00Z";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

async function root(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), "atticus-cli-critic-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(r, "org-pack"), { recursive: true });
  await cp(join(FORGE_CHANGE, "org-pack"), join(r, "org-pack"), { recursive: true });
  for (const x of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...x });
    if (!p.ok) throw new Error(String(x.id));
    const f = join(r, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FORGE_CHANGE, "openspec/changes", CHANGE), join(r, "openspec/changes", CHANGE), {
    recursive: true,
  });
  return r;
}

const replay = () =>
  ReplayRuntime.fromDir(join(FORGE_CHANGE, "recordings"), { now: () => new Date(NOW) });

describe("atticus critic --mode", () => {
  const env = { ATTICUS_REPLAY_DIR: join(FORGE_CHANGE, "recordings") };

  it("runs the AI lenses from the command line in replay mode", async () => {
    const r = await root();
    const c = capture();
    expect(await critic(r, CHANGE, { mode: "replay", json: true }, c.io, { env, now: NOW })).toBe(
      1,
    );
    const j = JSON.parse(c.out.join("\n")) as {
      open: { blocking: number; gaps: number };
      lenses: { lens: string; state: string }[];
    };
    expect(j.open).toMatchObject({ blocking: 14, gaps: 13 });
    expect(j.lenses.filter((l) => l.state === "ran").length).toBeGreaterThan(0);
  });

  it("runs only the deterministic layer when no --mode is given, whatever ATTICUS_RUNTIME says", async () => {
    const r = await root();
    for (const e of [{}, { ...env, ATTICUS_RUNTIME: "replay" }]) {
      const c = capture();
      expect(await critic(r, CHANGE, { gate: "plan" }, c.io, { env: e, now: NOW })).toBe(1);
      expect(c.out.some((l) => /lens skipped: .*layer 1 ran alone/.test(l))).toBe(true);
      expect(c.out[0]).not.toMatch(/14 blocking/);
    }
  });

  it("says plainly when replay has no recordings or the mode is unknown", async () => {
    const r = await root();
    let c = capture();
    expect(await critic(r, CHANGE, { mode: "replay" }, c.io, { env: {}, now: NOW })).toBe(2);
    expect(c.err[0]).toMatch(/ATTICUS_REPLAY_DIR/);
    c = capture();
    expect(await critic(r, CHANGE, { mode: "mock" }, c.io, { env: {}, now: NOW })).toBe(2);
    expect(c.err[0]).toMatch(/Mock mode is for tests/);
  });

  it("finding --gate picks the gate; without it the latest round across gates is used", async () => {
    const r = await root();
    const gap = "gap-slo-known-ledger";
    const issue = "data-retention-stated-data-l8";
    await critic(r, CHANGE, { gate: "design" }, capture().io, { now: NOW });
    // Asked at the design gate; the plan gate asks nothing new and links to that question.
    let c = capture();
    expect(await findingAction(r, CHANGE, gap, "ask", { by: "ari" }, c.io, { now: NOW })).toBe(0);
    await critic(r, CHANGE, { gate: "plan" }, capture().io, { now: LATER });
    c = capture();
    expect(await findingAction(r, CHANGE, gap, "ask", { by: "tia" }, c.io)).toBe(1);
    expect(c.err[0]).toMatch(/already asked \(by ari\)\. Already asked at the design gate/);
    // An issue raised at both gates: the plan gate's copy by default, the design copy on request.
    c = capture();
    expect(
      await findingAction(r, CHANGE, issue, "not-relevant", { by: "ari", reason: "x" }, c.io),
    ).toBe(0);
    c = capture();
    expect(
      await findingAction(
        r,
        CHANGE,
        issue,
        "not-relevant",
        { by: "ari", reason: "x", gate: "design" },
        c.io,
      ),
    ).toBe(0);
    c = capture();
    expect(
      await findingAction(
        r,
        CHANGE,
        issue,
        "not-relevant",
        { by: "ari", reason: "x", gate: "design" },
        c.io,
      ),
    ).toBe(1);
    expect(c.err[0]).toMatch(/already dismissed/);
    c = capture();
    expect(
      await findingAction(r, CHANGE, issue, "not-relevant", { by: "ari", gate: "nowhere" }, c.io),
    ).toBe(1);
    expect(c.err[0]).toMatch(/No finding/);
  });
});

describe("atticus critic", () => {
  it("runs the critic, lists findings, acts on one and reports stats", async () => {
    const r = await root();
    let c = capture();
    expect(await critic(r, undefined, {}, c.io)).toBe(2);
    c = capture();
    expect(await critic(r, CHANGE, { lens: "vibes" }, c.io)).toBe(2);
    expect(c.err).toEqual([
      "Unknown lens vibes. Use one of: business, architecture, story, ux, delivery, code-and-test, release.",
    ]);
    c = capture();
    expect(await critic(r, CHANGE, { gate: "nowhere" }, c.io)).toBe(2);
    expect(c.err[0]).toBe("There is no gate nowhere. Gates: design, plan, build, release.");

    c = capture();
    expect(await critic(r, CHANGE, {}, c.io, { runtime: await replay(), now: NOW })).toBe(1);
    expect(c.out[0]).toBe(
      "Critic round 1 of 2 at the plan gate for add-transfer-limit: 14 blocking, 13 gaps, 5 risks, 0 ideas.",
    );
    expect(c.out[1]).toMatch(/^SEVERITY\s+LAYER\s+ID\s+WHERE\s+SUMMARY$/);
    expect(
      c.out.some((l) =>
        /^blocking\s+checks\s+interface-approved-pattern-interfaces-l6\s+interfaces\.md:6\s+The hop portal-bff → ledger-api \(GET \/accounts\/\{id\}\/limit\) names pattern S\.GW\.SRO/.test(
          l,
        ),
      ),
    ).toBe(true);
    expect(
      c.out.some((l) => /^blocking\s+AI\s+design-concurrency-handled-design-l29\s/.test(l)),
    ).toBe(true);
    expect(c.out).toContain(
      "release lens skipped: no AI rule of this lens has an artifact that passed layer 1",
    );
    expect(c.out.at(-1)).toBe(
      "The plan gate is closed: 14 blocking, 13 open gaps. Act on each with atticus finding <id> <action>.",
    );

    c = capture();
    expect(await findings(r, CHANGE, {}, c.io)).toBe(0);
    expect(c.out[0]).toBe("plan gate, round 1:");
    expect(c.out.length).toBe(2 + 32 + 1);

    c = capture();
    expect(
      await findingAction(r, CHANGE, "interface-approved-pattern-interfaces-l6", "apply", {}, c.io),
    ).toBe(2);
    c = capture();
    expect(
      await findingAction(
        r,
        CHANGE,
        "interface-approved-pattern-interfaces-l6",
        "apply",
        { by: "ari" },
        c.io,
        { now: NOW },
      ),
    ).toBe(0);
    expect(c.out).toEqual(["Applied the fix to interfaces.md; the next critic round checks it."]);
    c = capture();
    expect(
      await findingAction(
        r,
        CHANGE,
        "story-acceptance-criteria-s2-show-remaining-l1",
        "waive",
        { by: "tia", reason: "later" },
        c.io,
      ),
    ).toBe(1);
    expect(c.err[0]).toMatch(/can never be waived/);
    c = capture();
    expect(
      await findingAction(
        r,
        CHANGE,
        "mappings-cover-interfaces-mappings-l1",
        "not-relevant",
        { by: "ari" },
        c.io,
      ),
    ).toBe(2);
    expect(c.err).toEqual(["Not relevant needs a reason (--reason)."]);
    c = capture();
    expect(await findingAction(r, CHANGE, "x", "dance", { by: "ari" }, c.io)).toBe(2);
    expect(c.err[0]).toBe(
      "Unknown action dance. Use one of: apply, edit-and-apply, not-relevant, waive, ask.",
    );

    c = capture();
    expect(await findings(r, CHANGE, { json: true }, c.io)).toBe(0);
    const j = JSON.parse(c.out.join("\n")) as {
      gate: string;
      findings: { id: string; state: string }[];
    }[];
    expect(
      j[0]!.findings.find((f) => f.id === "interface-approved-pattern-interfaces-l6")?.state,
    ).toBe("applied");

    c = capture();
    expect(await criticStats(r, {}, c.io)).toBe(0);
    expect(c.out[0]).toBe("Override rates across 1 change:");
    expect(
      c.out.some((l) => /^constitution\.interface-approved-pattern\s+2\s+0\s+0\s+0%$/.test(l)),
    ).toBe(true);
  });

  it("prints JSON and refuses a third round", async () => {
    const r = await root();
    let c = capture();
    expect(await critic(r, CHANGE, { json: true, lens: "story" }, c.io, { now: NOW })).toBe(1);
    const j = JSON.parse(c.out.join("\n")) as {
      round: number;
      mayProceed: boolean;
      findings: { lens: string; layer: string }[];
    };
    expect(j.round).toBe(1);
    expect(j.mayProceed).toBe(false);
    expect(new Set(j.findings.map((f) => f.lens))).toEqual(new Set(["story"]));
    c = capture();
    await critic(r, CHANGE, {}, c.io, { now: NOW });
    c = capture();
    expect(await critic(r, CHANGE, {}, c.io, { now: NOW })).toBe(1);
    expect(c.err[0]).toMatch(
      /^The plan gate has had 2 critic rounds, the most it allows\. A person decides now/,
    );
    c = capture();
    expect(await findings(r, "missing", {}, c.io)).toBe(1);
    c = capture();
    expect(
      await criticStats(await mkdtemp(join(tmpdir(), "atticus-cli-critic-empty-")), {}, c.io),
    ).toBe(0);
    expect(c.out).toEqual(["No critic findings yet."]);
  });
});
