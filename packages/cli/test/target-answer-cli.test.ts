import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  raiseQuestions,
  readQuestion,
  TARGETS_ANOTHER_LABEL,
  TARGETS_STEP_ID,
  topicQuestionText,
  TOPICS_OUTSIDE_LABEL,
  TOPICS_STEP_ID,
} from "@maycombhq/core";
import { questionsFiles } from "../src/question-commands.js";

/**
 * ADR 0162 (F8): `atticus questions answer <id> --target <id>` names any repo of the manifest, any
 * system of the profile or a team in roles.yaml (the "Another repo…" picker); a vendor not in the
 * profile, or a team with no system, is offered as a new system, written with --add-system as a
 * file change for review. On the invented bank-shaped estate (fixtures/link-estate).
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "link-estate");
const AT = "2026-11-01T12:00:00.000Z";
const PROFILE = ["org-pack", "profiles", "forge", "profile.yaml"];

const ROLES = `schemaVersion: 2
teams:
  - { id: team-cards, name: Cards team }
  - { id: team-ledger-ops, name: Ledger Ops }
`;

async function metarepo() {
  const root = await mkdtemp(join(tmpdir(), "atticus-target-answer-"));
  await cp(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  await writeFile(join(root, "org-pack", "roles.yaml"), ROLES);
  const { raised } = await raiseQuestions(
    root,
    [
      {
        question: "Which repo or system answers GET /limits/{id}, which payments-api calls?",
        options: [
          { label: "forge-accounts", means: "it serves GET /limits/{id}", changes: "joins it" },
          { label: TARGETS_ANOTHER_LABEL, means: "the picker", changes: "name one" },
          { label: "None of these", means: "nothing", changes: "a loose end" },
        ],
        evidence: ["src/main/java/forge/payments/PaymentsService.java:24"],
        scope: "repo",
      },
    ],
    {
      step: TARGETS_STEP_ID,
      repo: "forge-payments",
      command: "atticus verify forge-payments --write",
      rerun: "atticus verify forge-payments --write",
      at: AT,
    },
  );
  return { root, id: raised[0]!.id };
}

const run = async (root: string, args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await questionsFiles(
    root,
    ["questions", ...args],
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    { now: new Date(AT) },
  );
  return { code, out, err };
};

const systems = async (root: string) =>
  (
    parse(await readFile(join(root, ...PROFILE), "utf8")) as {
      systems: { id: string; name: string; boundary: string; owner?: string; aliases?: string[] }[];
    }
  ).systems;

describe("atticus questions answer --target (ADR 0162)", () => {
  it("takes a repo not read yet, by its id or its component", async () => {
    const { root, id } = await metarepo();
    const r = await run(root, ["answer", id, "--target", "cards-api", "--by", "pat"]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toMatch(new RegExp(`^Answered ${id}: cards-api `));
    expect((await readQuestion(root, id))!.answer).toMatchObject({ text: "cards-api" });
  });

  it("takes another team's system", async () => {
    const { root, id } = await metarepo();
    const r = await run(root, ["answer", id, "--target", "harbor-audit", "--by", "pat"]);
    expect(r.code).toBe(0);
    expect((await readQuestion(root, id))!.answer?.text).toBe("harbor-audit");
  });

  it("offers a system for a team with none, and writes it with --add-system", async () => {
    const { root, id } = await metarepo();
    const r = await run(root, ["answer", id, "--target", "team-ledger-ops", "--by", "pat"]);
    expect(r.code).toBe(2);
    expect(r.err).toEqual([
      "team-ledger-ops has no system in the profile yet.",
      `To add it as another team's system, Ledger Ops's system (id team-ledger-ops-system, owner team-ledger-ops) in the profile, written as a file change for review in the pull request: atticus questions answer ${id} --target team-ledger-ops --add-system internal (--name "..." to name it).`,
    ]);
    expect((await readQuestion(root, id))!.state).toBe("open");
    const w = await run(root, [
      "answer",
      id,
      "--target",
      "team-ledger-ops",
      "--add-system",
      "internal",
      "--by",
      "pat",
    ]);
    expect(w.code).toBe(0);
    expect(w.out[0]).toBe(
      "Wrote the system team-ledger-ops-system (boundary internal, owner team-ledger-ops) into org-pack/profiles/forge/profile.yaml; review it in the same pull request.",
    );
    expect((await systems(root)).find((s) => s.id === "team-ledger-ops-system")).toMatchObject({
      boundary: "internal",
      owner: "team-ledger-ops",
    });
    expect((await readQuestion(root, id))!.answer?.text).toBe("team-ledger-ops-system");
  });

  it("offers a vendor the profile doesn't have, and adds it with --add-system vendor", async () => {
    const { root, id } = await metarepo();
    const r = await run(root, ["answer", id, "--target", "Tidewater", "--by", "pat"]);
    expect(r.code).toBe(2);
    expect(r.err[0]).toBe(
      "Tidewater isn't a repo of the manifest, a system of the profile or a team in roles.yaml.",
    );
    expect(r.err[1]).toContain("--target Tidewater --add-system vendor");
    const w = await run(root, ["answer", id, "--target", "Tidewater", "--add-system", "vendor"]);
    expect(w.code).toBe(0);
    expect((await systems(root)).find((s) => s.id === "tidewater")).toMatchObject({
      name: "Tidewater",
      boundary: "vendor",
    });
  });

  it("prints the picker when Another repo… is picked as an option", async () => {
    const { root, id } = await metarepo();
    const r = await run(root, ["answer", id, "--option", "2", "--by", "pat"]);
    expect(r.code).toBe(2);
    expect(r.err[0]).toContain("--target <id>");
    expect(r.err[1]).toMatch(/^ {2}Repos \(10\): forge-accounts \(not read yet\), /);
    expect(r.err[3]).toBe("  Teams (2): team-cards, team-ledger-ops (no system yet)");
  });
});

describe("atticus questions answer --target on a topics question (ADR 0162)", () => {
  async function topicQuestion() {
    const root = await mkdtemp(join(tmpdir(), "atticus-topic-answer-"));
    await cp(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
    await writeFile(join(root, "org-pack", "roles.yaml"), ROLES);
    const { raised } = await raiseQuestions(
      root,
      [
        {
          question: topicQuestionText("harbor.audit.events", "cards-api", "listen"),
          options: [
            { label: TOPICS_OUTSIDE_LABEL, means: "the picker", changes: "an alias" },
            { label: "None of these", means: "nothing", changes: "a loose end" },
          ],
          evidence: ["src/main/java/forge/cards/AuditListener.java:9"],
          scope: "repo",
        },
      ],
      {
        step: TOPICS_STEP_ID,
        repo: "forge-cards",
        command: "atticus verify forge-cards --write",
        rerun: "atticus verify forge-cards --write",
        at: AT,
      },
    );
    return { root, id: raised[0]!.id };
  }

  it("adds the topic to another team's system's aliases", async () => {
    const { root, id } = await topicQuestion();
    const r = await run(root, ["answer", id, "--target", "harbor-audit", "--by", "pat"]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe(
      "Wrote harbor.audit.events under aliases of harbor-audit in org-pack/profiles/forge/profile.yaml, so the next write lands it there; review it in the same pull request.",
    );
    const text = await readFile(join(root, ...PROFILE), "utf8");
    expect(text).toContain("# Invented vendors, each named by the host the code calls it on.");
    expect((await systems(root)).find((s) => s.id === "harbor-audit")).toMatchObject({
      aliases: ["harbor.audit.events"],
    });
    expect((await readQuestion(root, id))!.answer?.text).toBe("harbor-audit");
  });

  it("creates a team's system with the topic as its alias, and refuses a repo of the estate", async () => {
    const { root, id } = await topicQuestion();
    const repo = await run(root, ["answer", id, "--target", "forge-payments"]);
    expect(repo.code).toBe(2);
    expect(repo.err[0]).toContain("forge-payments is a repo of the estate");
    const w = await run(root, [
      "answer",
      id,
      "--target",
      "team-ledger-ops",
      "--add-system",
      "internal",
    ]);
    expect(w.code).toBe(0);
    expect((await systems(root)).find((s) => s.id === "team-ledger-ops-system")).toMatchObject({
      owner: "team-ledger-ops",
      aliases: ["harbor.audit.events"],
    });
  });

  it("prints the picker when the topic option is picked as an option", async () => {
    const { root, id } = await topicQuestion();
    const r = await run(root, ["answer", id, "--option", "1"]);
    expect(r.code).toBe(2);
    expect(r.err[1]).toMatch(/^ {2}Repos \(10\)/);
  });
});
