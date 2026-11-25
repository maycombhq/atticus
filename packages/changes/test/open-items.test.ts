import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toCanonicalYaml } from "@maycombhq/core";
import type { OpenSpec, ValidationReport } from "@maycombhq/openspec-adapter";
import {
  archiveChange,
  canAdvance,
  changeReport,
  changeStore,
  handoff,
  newChange,
  requireValid,
  syncHandoff,
} from "../src/index.js";
import {
  FEATURE_OWNERS,
  REPO,
  approval,
  copyPhase,
  forgeMetarepo,
  host,
  passedRound,
} from "./helpers.js";

/**
 * ADR 0210 part 7: the change path's gates become open items on the change. A hand-off goes ahead
 * with them, and its PR lists them under "Open items": the person who approves it decides them.
 * A constitution finding, the quarantine rule and an unfinished critic round still stop it.
 */

const ID = "add-transfer-limit";
const T = (h: string) => `2026-11-24T${h}:00Z`;

async function inDesign(root: string, gh: ReturnType<typeof host>) {
  await newChange(root, {
    title: "Add transfer limit",
    type: "feature",
    by: "pat",
    owners: FEATURE_OWNERS,
    systems: ["ledger", "portal"],
    now: T("09:00"),
  });
  await copyPhase(root, ID, `${ID}/define`);
  await handoff(root, ID, {
    gitHost: gh,
    repo: REPO,
    by: "pat",
    approval: approval("pat", T("10:00")),
    now: T("10:00"),
  });
  gh.review(REPO, 1, "ari", "approved");
  await syncHandoff(root, ID, {
    gitHost: gh,
    repo: REPO,
    approval: approval("pat", T("11:00")),
    now: T("11:00"),
  });
  await copyPhase(root, ID, `${ID}/design`);
  await passedRound(root, ID, "design");
}

function finding(over: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    id: "f1",
    kind: "issue",
    change: ID,
    gate: "design",
    round: 2,
    rule: "forge-arch-retry",
    layer: "org",
    lens: "architecture",
    severity: "blocking",
    artifact: "design.md",
    locator: { heading: "Approach" },
    summary: "The Ledger call has no retry budget.",
    why: "Forge's architecture rules ask for one.",
    fix: { text: "Name the retry budget." },
    evidence: [{ source: "artifact", path: "design.md" }],
    waivable: true,
    state: "open",
    createdAt: T("12:00"),
    ...over,
  };
}

async function writeFinding(root: string, f: ReturnType<typeof finding>) {
  const dir = join(root, "openspec/changes", ID, "review", String(f.gate), String(f.round));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${String(f.id)}.yaml`), toCanonicalYaml(f));
}

const bodyOf = (gh: ReturnType<typeof host>) =>
  (gh.journal.filter((j) => j.method === "createPullRequest").at(-1)!.args[0] as { body: string })
    .body;

describe("open items (ADR 0210 part 7)", () => {
  it("a hand-off goes ahead with an open org blocking finding and its PR lists it under Open items", async () => {
    const root = await forgeMetarepo();
    const gh = host();
    await inDesign(root, gh);
    await writeFinding(root, finding({}));
    await writeFinding(
      root,
      finding({
        id: "gap",
        kind: "knowledge-gap",
        severity: "gap",
        layer: "team",
        waivable: false,
        summary: "What is the Ledger timeout?",
        question: { text: "What is the Ledger timeout?", owner: "team-ledger" },
      }),
    );
    const r = await changeReport(root, ID);
    expect(r.blockers).toEqual([]);
    expect(r.ready).toBe(true);
    expect(r.openItems.map((x) => [x.code, x.finding])).toEqual([
      ["blocking-finding", "f1"],
      ["open-gap", "gap"],
    ]);
    expect((await canAdvance(ID, root)).reasons.map((x) => x.code)).toEqual(["no-handoff"]);

    await handoff(root, ID, {
      gitHost: gh,
      repo: REPO,
      by: "ari",
      approval: approval("ari", T("12:30")),
      now: T("12:30"),
    });
    const body = bodyOf(gh);
    expect(body).toContain("### Open items");
    expect(body).toContain(
      "- Blocking finding f1 on the design gate (round 2): The Ledger call has no retry budget.",
    );
    expect(body).toContain("Knowledge gap gap on the design gate (round 2)");
    // The person's approval on the Git host is the gate: the merge goes ahead with them open.
    gh.review(REPO, 2, "avery", "approved");
    expect(
      await syncHandoff(root, ID, {
        gitHost: gh,
        repo: REPO,
        approval: approval("avery", T("13:00")),
        now: T("13:00"),
      }),
    ).toMatchObject({ merged: true, state: "plan" });
  });

  it("a constitution finding still stops the hand-off", async () => {
    const root = await forgeMetarepo();
    const gh = host();
    await inDesign(root, gh);
    await writeFinding(
      root,
      finding({ rule: "constitution.public-entry-auth", layer: "constitution", waivable: false }),
    );
    const e = await handoff(root, ID, {
      gitHost: gh,
      repo: REPO,
      by: "ari",
      approval: approval("ari", T("12:30")),
    }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "refused" });
    expect((e as { reasons: { code: string; openItem?: true }[] }).reasons).toEqual([
      expect.objectContaining({ code: "blocking-finding", finding: "f1" }),
    ]);
    expect((await changeReport(root, ID)).openItems).toEqual([]);
  });

  it("the quarantine rule's gap (layer constitution) still stops the hand-off", async () => {
    const root = await forgeMetarepo();
    const gh = host();
    await inDesign(root, gh);
    await writeFinding(
      root,
      finding({
        id: "quarantined",
        kind: "knowledge-gap",
        severity: "gap",
        rule: "defences.quarantine",
        layer: "constitution",
        waivable: false,
        summary: "Left out of the architecture lens: a page with hidden instructions",
        question: { text: "What do we do with it?", owner: "pat" },
      }),
    );
    const r = await changeReport(root, ID);
    expect(r.blockers.map((x) => x.code)).toEqual(["open-gap"]);
    expect(r.openItems).toEqual([]);
  });

  it("an unfinished critic round still stops the hand-off", async () => {
    const root = await forgeMetarepo();
    const gh = host();
    await inDesign(root, gh);
    await writeFinding(root, finding({}));
    const dir = join(root, "openspec/changes", ID, "review/design/3/meta");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "round.yaml"),
      toCanonicalYaml({
        schemaVersion: 1,
        change: ID,
        gate: "design",
        round: 3,
        state: "in-progress",
      }),
    );
    const e = await handoff(root, ID, {
      gitHost: gh,
      repo: REPO,
      by: "ari",
      approval: approval("ari", T("12:30")),
    }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "refused" });
    expect((e as { reasons: { code: string }[] }).reasons.map((x) => x.code)).toEqual([
      "round-unfinished",
    ]);
  });

  it("a mandatory gate with no critic round is an open item", async () => {
    const root = await forgeMetarepo();
    const gh = host();
    await inDesign(root, gh);
    // Forge's profile makes design mandatory; no round at all now.
    const { rm } = await import("node:fs/promises");
    await rm(join(root, "openspec/changes", ID, "review"), { recursive: true, force: true });
    const r = await changeReport(root, ID);
    expect(r.blockers).toEqual([]);
    expect(r.openItems.map((x) => x.code)).toEqual(["critic-round-missing"]);
  });

  it("a stage waiting on a person's answers is an open item at its hand-off", async () => {
    const root = await forgeMetarepo();
    const gh = host();
    await inDesign(root, gh);
    await mkdir(join(root, "openspec/changes", ID, "stage"), { recursive: true });
    await writeFile(
      join(root, "openspec/changes", ID, "stage/architecture.yaml"),
      `schemaVersion: 1\nchange: ${ID}\nstage: architecture\niteration: 1\nstate: questions\nupdatedAt: ${T("12:00")}\n`,
    );
    const r = await changeReport(root, ID);
    expect(r.blockers.map((x) => x.code)).not.toContain("stage-not-done");
    expect(r.openItems.map((x) => x.code)).toContain("stage-not-done");
    expect(r.openItems.find((x) => x.code === "stage-not-done")?.message).toMatch(
      /waits for a person to answer its questions/,
    );
  });

  it("a stage that went on with what it found carries it to its hand-off as open items", async () => {
    const root = await forgeMetarepo();
    const gh = host();
    await inDesign(root, gh);
    await mkdir(join(root, "openspec/changes", ID, "stage"), { recursive: true });
    await writeFile(
      join(root, "openspec/changes", ID, "stage/architecture.yaml"),
      [
        "schemaVersion: 1",
        `change: ${ID}`,
        "stage: architecture",
        "iteration: 3",
        "state: done",
        "openItems:",
        "  - The architecture stage went on after 3 drafts with a finding its drafts kept repeating.",
        `updatedAt: ${T("12:00")}`,
        "",
      ].join("\n"),
    );
    const r = await changeReport(root, ID);
    expect(r.openItems.map((x) => x.message)).toContain(
      "The architecture stage went on after 3 drafts with a finding its drafts kept repeating.",
    );
  });

  it("OpenSpec validation's warnings are open items; its errors stay errors", async () => {
    const os = (issues: ValidationReport["items"][number]["issues"], valid: boolean) =>
      ({
        root: "/x",
        validate: async () => ({
          items: [{ id: ID, type: "change", valid, issues }],
          summary: { totals: { items: 1, passed: valid ? 1 : 0, failed: valid ? 0 : 1 } },
        }),
      }) as unknown as OpenSpec;
    const open = await requireValid(
      os(
        [{ level: "WARNING", path: "specs/transfers/spec.md", message: "Requirement too long" }],
        false,
      ),
      ID,
    );
    expect(open).toEqual([
      {
        code: "openspec-invalid",
        message: "specs/transfers/spec.md: Requirement too long",
        openItem: true,
      },
    ]);
    await expect(
      requireValid(
        os(
          [{ level: "ERROR", path: "specs/transfers/spec.md", message: "No requirements" }],
          false,
        ),
        ID,
      ),
    ).rejects.toMatchObject({ code: "refused" });
  });

  it("the next step says the hand-off is ready with its open items", async () => {
    const root = await forgeMetarepo();
    const gh = host();
    await inDesign(root, gh);
    await writeFinding(root, finding({}));
    const store = changeStore(root);
    expect((await store.read(ID)).state).toBe("design");
    const r = await changeReport(root, ID);
    expect(r.nextStep).toBe(
      'Ready to raise "Approve design": its PR lists 1 open item for the person who approves it.',
    );
  });

  it("archive goes ahead with post-release findings and unticked tasks, and records them", async () => {
    const root = await forgeMetarepo();
    const fixture = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../fixtures/forge-change/openspec/changes",
      ID,
    );
    const dir = join(root, "openspec/changes", ID);
    await cp(fixture, dir, { recursive: true });
    const p = join(dir, "change.yaml");
    const path = ["plan", "build", "qa", "release-ready", "released", "post-release-review"];
    const entries = path
      .slice(1)
      .map(
        (to, i) =>
          `  - from: ${path[i]}\n    to: ${to}\n    at: 2026-11-2${i}T10:00:00Z\n    by: tia\n    reason: Moved on for the test`,
      )
      .join("\n");
    await writeFile(
      p,
      (await readFile(p, "utf8"))
        .replace(/^state: plan$/m, "state: post-release-review")
        .replace(/( {4}reason: Approve design merged\n)/, `$1${entries}\n`),
    );
    await writeFinding(
      root,
      finding({
        id: "slow-limit",
        gate: "post-release-review",
        round: 1,
        summary: "The limit check is slow.",
      }),
    );
    const asked: unknown[] = [];
    const os = {
      root: "/x",
      validate: async () => ({
        items: [{ id: ID, type: "change", valid: true, issues: [] }],
        summary: { totals: { items: 1, passed: 1, failed: 0 } },
      }),
      archive: async (_id: string, o: unknown) => {
        asked.push(o);
        return { change: ID, archivedAs: `2026-11-24-${ID}`, path: "x", specsUpdated: true };
      },
    } as unknown as OpenSpec;
    const done = await archiveChange(root, ID, { by: "dana", openspec: os, now: T("15:00") });
    expect(done.state).toBe("archived");
    expect(asked).toEqual([{ requireTasksComplete: false }]);
    const reason = done.history.at(-1)!.reason!;
    expect(reason).toMatch(/^Archived with open items: /);
    expect(reason).toContain("Blocking finding slow-limit on the post-release-review gate");
    expect(reason).toMatch(/tasks? (isn't|aren't) ticked in tasks\.md\./);
  });
});
