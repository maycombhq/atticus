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

  it("an assistant's resolution of a blocking finding leaves it an open item that says so", async () => {
    const root = await forgeMetarepo();
    const gh = host();
    await inDesign(root, gh);
    await writeFinding(
      root,
      finding({
        state: "waived",
        resolution: { action: "waive", by: "story-writer", at: T("12:10"), reason: "Fine." },
      }),
    );
    const r = await changeReport(root, ID);
    expect(r.openItems.map((x) => x.message)).toEqual([
      "Blocking finding f1 on the design gate (round 2): The Ledger call has no retry budget. An assistant (story-writer) waived it, which closes nothing: only a person's decision does.",
    ]);
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

describe("open items the approver has seen (ADR 0210 part 7, review of PR #21)", () => {
  const raise = (root: string, gh: ReturnType<typeof host>, at: string) =>
    handoff(root, ID, {
      gitHost: gh,
      repo: REPO,
      by: "ari",
      approval: approval("ari", T(at)),
      now: T(at),
    });
  const sync = (root: string, gh: ReturnType<typeof host>, at: string) =>
    syncHandoff(root, ID, {
      gitHost: gh,
      repo: REPO,
      approval: approval("avery", T(at)),
      now: T(at),
    });
  const comments = (gh: ReturnType<typeof host>) =>
    gh.journal.filter((j) => j.method === "comment").map((j) => String(j.args[2]));
  const later = finding({ id: "f2", summary: "The limit has no audit trail." });

  it("an open item raised after the approval is posted on the PR and needs a new approval before the merge", async () => {
    const root = await forgeMetarepo();
    const gh = host();
    await inDesign(root, gh);
    await writeFinding(root, finding({}));
    const h = await raise(root, gh, "12:30");
    expect(h.openItems?.items.join("\n")).toContain("Blocking finding f1");
    // ADR 0210 part 7: a change.yaml that gets open items is written at version 2.
    const text = await readFile(join(root, "openspec/changes", ID, "change.yaml"), "utf8");
    expect(text).toMatch(/^schemaVersion: 2$/m);
    gh.review(REPO, 2, "avery", "approved");
    // A new org finding after the approver looked: not merged unseen.
    await writeFinding(root, later);
    const s1 = await sync(root, gh, "13:00");
    expect(s1.merged).toBe(false);
    expect(s1.reasons.map((r) => r.code)).toEqual(["open-items-changed"]);
    const posted = comments(gh).at(-1)!;
    expect(posted).toContain("Open items");
    expect(posted).toContain(
      "Blocking finding f2 on the design gate (round 2): The limit has no audit trail.",
    );
    expect(posted).toContain("Blocking finding f1");
    // The approval from before the list was posted doesn't count for it.
    const s2 = await sync(root, gh, "13:10");
    expect(s2.merged).toBe(false);
    expect(s2.reasons.map((r) => r.code)).toEqual(["open-items-unseen"]);
    gh.review(REPO, 2, "avery", "approved");
    const s3 = await sync(root, gh, "13:20");
    expect(s3).toMatchObject({ merged: true, state: "plan" });
    // Durable: the merge's history entry keeps what it went ahead with.
    const merged = (await changeStore(root).read(ID)).history.at(-1)!;
    expect(merged.openItems?.join("\n")).toContain("Blocking finding f2");
    expect(merged.openItems?.join("\n")).toContain("Blocking finding f1");
  });

  it("an updated hand-off rewrites its PR's Open items and says them in its update comment", async () => {
    const root = await forgeMetarepo();
    const gh = host();
    await inDesign(root, gh);
    await writeFinding(root, finding({}));
    await raise(root, gh, "12:30");
    gh.review(REPO, 2, "avery", "changes-requested");
    await sync(root, gh, "13:00");
    await writeFinding(root, later);
    const h = await raise(root, gh, "13:30");
    const pr = await gh.getPullRequest(REPO, 2);
    expect(pr.body).toContain("### Open items");
    expect(pr.body).toContain("Blocking finding f2");
    expect(comments(gh).at(-1)).toContain("Blocking finding f2");
    expect(h.openItems?.items.join("\n")).toContain("Blocking finding f2");
  });

  it("archive records every open item the change carried, not only the post-release ones", async () => {
    const root = await forgeMetarepo();
    const gh = host();
    await inDesign(root, gh);
    await writeFinding(root, finding({}));
    await raise(root, gh, "12:30");
    gh.review(REPO, 2, "avery", "approved");
    await sync(root, gh, "13:00");
    const store = changeStore(root);
    const c = await store.read(ID);
    const path = ["plan", "build", "qa", "release-ready", "released"];
    await store.write({
      ...c,
      state: "released",
      history: [
        ...c.history,
        ...path.slice(1).map((to, i) => ({ from: path[i]!, to, at: T("14:00"), by: "tia" })),
      ] as typeof c.history,
    });
    const done = await archiveChange(root, ID, { by: "dana", now: T("15:00") });
    const entry = done.history.at(-1)!;
    expect(entry.openItems?.join("\n")).toContain("Blocking finding f1 on the design gate");
    expect(entry.reason).toContain("Blocking finding f1 on the design gate");
  });
});
