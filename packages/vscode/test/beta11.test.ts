import { describe, expect, it } from "vitest";
import { answerQuestion } from "../src/atticus";
import {
  contractsStatus,
  contractsWords,
  noteArgs,
  noteOf,
  offerWords,
  opensPicker,
  pickRows,
  readContractCounts,
  readPicks,
  repoTypesIn,
  targetArgs,
  targetPlan,
  TYPE_ANOTHER,
  type TargetPick,
} from "../src/beta11";
import { JOBS, jobArgv, jobByCommand, routeAsk } from "../src/jobs";
import { statusText } from "../src/words";
import type { Cli, CliResult, OpenQuestion } from "../src/types";

/**
 * What beta.11 added, caught up in the extension (ADR 0166): the "Another repo…" picker of a
 * target or topics question, with a new system asked before it is written; the contract check's
 * command and count; the repo types' notes and their rule drafts as commands run only on a
 * click; and doctor --counts, safe to paste. No VS Code: a fake command line answers.
 */

const ok = (stdout: unknown, code = 0): CliResult => ({
  code,
  stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
  stderr: "",
  cancelled: false,
});

function fakeCli(answers: (args: string[]) => CliResult) {
  const asked: string[][] = [];
  const cli: Cli = async (args) => {
    asked.push(args);
    return answers(args);
  };
  return { cli, asked };
}

const PICKS: TargetPick[] = [
  { id: "forge-accounts", kind: "repo", name: "forge-accounts", read: false },
  { id: "forge-ledger", kind: "repo", name: "forge-ledger (ledger-api)", read: true },
  { id: "harbor-audit", kind: "system", name: "Harbor Audit", boundary: "internal" },
  { id: "northwind-pay", kind: "system", name: "Northwind Pay", boundary: "vendor" },
  { id: "team-cards", kind: "team", name: "Cards team" },
  {
    id: "team-ledger-ops",
    kind: "team",
    name: "Ledger Ops",
    adds: {
      id: "team-ledger-ops-system",
      name: "Ledger Ops's system",
      boundary: "internal",
      owner: "team-ledger-ops",
    },
  },
];

const TARGETS_Q: OpenQuestion = {
  id: "q-1",
  repo: "forge-payments",
  question: "Which repo or system answers GET /limits/{id}, which payments-api calls?",
  options: [{ label: "forge-accounts" }, { label: "Another repo…" }, { label: "None of these" }],
  evidence: [],
  askedBy: { step: "facts-targets" },
};

describe("Another repo… opens the picker (ADR 0162, F8)", () => {
  it("knows the options that open it, on a targets and a topics question", () => {
    expect(opensPicker(TARGETS_Q, 2)).toBe(true);
    expect(opensPicker(TARGETS_Q, 1)).toBe(false);
    expect(opensPicker(TARGETS_Q, 3)).toBe(false);
    expect(
      opensPicker({ options: [{ label: "A topic owned by another team or vendor" }] }, 1),
    ).toBe(true);
  });

  it("reads the picker from questions show --json", async () => {
    const { cli, asked } = fakeCli(() => ok({ id: "q-1", picks: PICKS }));
    const r = await readPicks(cli, "/m", "q-1");
    expect(asked[0]).toEqual(["questions", "show", "q-1", "--json", "--root", "/m"]);
    expect(r).toEqual({ ok: true, picks: PICKS });
  });

  it("says an older command line gives no picker, and what failed", async () => {
    const old = await readPicks(fakeCli(() => ok({ id: "q-1" })).cli, "/m", "q-1");
    expect(old.ok).toBe(false);
    expect(!old.ok && old.message).toMatch(/2\.0\.0-beta\.11/);
    const gone = await readPicks(
      fakeCli(() => ({ code: 1, stdout: "", stderr: "No question q-1.\n", cancelled: false })).cli,
      "/m",
      "q-1",
    );
    expect(gone).toEqual({ ok: false, message: "No question q-1." });
  });

  it("lists repos, systems and teams, each saying what it is, then a name typed", () => {
    const rows = pickRows(PICKS);
    expect(rows[0]).toEqual({ separator: "Repos" });
    expect(rows[1]).toMatchObject({
      label: "forge-accounts",
      description: "not read yet",
      target: "forge-accounts",
    });
    expect(rows[2]).toMatchObject({ label: "forge-ledger (ledger-api)", description: "read" });
    expect(rows[3]).toEqual({ separator: "Systems in the profile" });
    expect(rows[4]).toMatchObject({
      label: "Harbor Audit (harbor-audit)",
      description: "internal",
    });
    expect(rows.find((r) => "target" in r && r.target === "team-ledger-ops")).toMatchObject({
      description: "no system yet: adds one to the profile, after your yes",
    });
    expect(rows.at(-1)).toMatchObject({ label: TYPE_ANOTHER, target: "" });
  });

  it("answers with a repo, a system or a team that has one, as it is", () => {
    expect(targetPlan(PICKS, "forge-accounts")).toEqual({ target: "forge-accounts" });
    expect(targetPlan(PICKS, "Harbor-Audit")).toEqual({ target: "harbor-audit" });
    expect(targetPlan(PICKS, "team-cards")).toEqual({ target: "team-cards" });
    expect(targetPlan(PICKS, "  ")).toBeUndefined();
  });

  it("offers a new system for a team with none, or a name not listed, before writing", () => {
    const team = targetPlan(PICKS, "team-ledger-ops");
    expect(team).toEqual({
      target: "team-ledger-ops",
      offer: {
        id: "team-ledger-ops-system",
        name: "Ledger Ops's system",
        boundary: "internal",
        owner: "team-ledger-ops",
      },
    });
    const vendor = targetPlan(PICKS, "Tidewater Clearing");
    expect(vendor).toEqual({
      target: "Tidewater Clearing",
      offer: { id: "tidewater-clearing", name: "Tidewater Clearing", boundary: "vendor" },
    });
    expect(offerWords((vendor as Extract<typeof vendor, { offer: unknown }>).offer)).toMatch(
      /^Tidewater Clearing isn't a repo .* \(id tidewater-clearing\), for review in the pull request\?$/,
    );
    expect(offerWords((team as Extract<typeof team, { offer: unknown }>).offer)).toMatch(
      /owner team-ledger-ops/,
    );
  });

  it("answers with --target, and --add-system only once the person said yes", async () => {
    expect(targetArgs({ target: "harbor-audit" })).toEqual(["--target", "harbor-audit"]);
    const { cli, asked } = fakeCli(() => ok("Answered q-1: tidewater-clearing\n"));
    const done = await answerQuestion(cli, "/m", "q-1", {
      target: "Tidewater Clearing",
      addSystem: "vendor",
    });
    expect(done.ok).toBe(true);
    expect(asked[0]).toEqual([
      "questions",
      "answer",
      "q-1",
      "--target",
      "Tidewater Clearing",
      "--add-system",
      "vendor",
      "--root",
      "/m",
    ]);
    const rule = fakeCli(() => ok(""));
    await answerQuestion(
      rule.cli,
      "/m",
      "q-1",
      { target: "forge-accounts" },
      { match: "/forge/limits/**" },
    );
    expect(rule.asked[0]).toEqual([
      "questions",
      "answer",
      "q-1",
      "--target",
      "forge-accounts",
      "--match",
      "/forge/limits/**",
      "--root",
      "/m",
    ]);
  });
});

describe("the contract check (ADR 0164, F7)", () => {
  const COUNTS = { links: 12, compared: 9, mismatches: 3, unconfirmed: 2 };

  it("is a command that lists join contracts and opens Map › Mismatches", () => {
    const j = jobByCommand("atticus.contractMismatches")!;
    expect(jobArgv(j, {})).toEqual(["join", "contracts"]);
    expect(j.how).toBe("report");
    expect(j.app?.({})).toBe("#/mismatches");
  });

  it("reads the counts with join contracts --json, and says them in the status bar", async () => {
    const { cli, asked } = fakeCli(() =>
      ok({ links: [], findings: [], counts: COUNTS, notes: [] }),
    );
    const c = await readContractCounts(cli, "/m");
    expect(asked[0]).toEqual(["join", "contracts", "--json", "--root", "/m"]);
    expect(c).toEqual(COUNTS);
    expect(contractsStatus(c)).toBe("3 contract mismatches");
    expect(statusText(2, undefined, undefined, 0, contractsStatus(c))).toBe(
      "$(shield) Atticus: 2 questions · 3 contract mismatches",
    );
    expect(contractsWords(c)).toBe(
      "Contract check: 3 mismatches, 2 unconfirmed, on 9 links compared (Map › Mismatches).",
    );
  });

  it("says nothing in the status bar when nothing mismatches or it can't tell", async () => {
    expect(contractsStatus({ ...COUNTS, mismatches: 0 })).toBeUndefined();
    expect(contractsStatus(undefined)).toBeUndefined();
    expect(contractsWords({ links: 4, compared: 0, mismatches: 0, unconfirmed: 0 })).toMatch(
      /no link has a payload on both sides/,
    );
    expect(await readContractCounts(fakeCli(() => ok("", 1)).cli, "/m")).toBeUndefined();
    expect(await readContractCounts(fakeCli(() => ok("not json")).cli, "/m")).toBeUndefined();
  });
});

describe("a repo type's notes and their rule drafts (ADR 0163, F9)", () => {
  it("lists a type's notes or the org-wide ones, read-only", () => {
    const j = jobByCommand("atticus.repoTypeNotes")!;
    expect(j.how).toBe("report");
    expect(jobArgv(j, { repoType: "spring-service" })).toEqual([
      "repo-type",
      "note",
      "spring-service",
    ]);
    expect(jobArgv(j, { repoType: "" })).toEqual(["repo-type", "note", "--org-wide"]);
  });

  it("adds a note only after the person's yes, the command shown first", () => {
    const j = jobByCommand("atticus.repoTypeAddNote")!;
    expect(j.how).toBe("confirm");
    expect(j.needs).toBe("note");
    expect(
      jobArgv(j, { repoType: "spring-service", note: "Every call to the ledger uses mTLS" }),
    ).toEqual([
      "repo-type",
      "note",
      "spring-service",
      "--add",
      "Every call to the ledger uses mTLS",
    ]);
    expect(noteArgs("", "x")).toEqual(["repo-type", "note", "--org-wide", "--add", "x"]);
    expect(noteOf("  two\n lines ")).toBe("two lines");
    expect(noteOf("   ")).toBeUndefined();
    expect(noteOf("x".repeat(1001))).toBeUndefined();
  });

  it("drafts rules read-only, and saves them only on a click and a yes", () => {
    const rules = jobByCommand("atticus.repoTypeRules")!;
    expect(jobArgv(rules, {})).toEqual(["repo-type", "rules"]);
    expect(rules.how).toBe("report");
    expect(rules.then).toEqual({ label: "Save the drafts…", command: "atticus.repoTypeRulesSave" });
    const save = jobByCommand("atticus.repoTypeRulesSave")!;
    expect(jobArgv(save, {})).toEqual(["repo-type", "rules", "--save"]);
    expect(save.how).toBe("confirm");
  });

  it("lists the org pack's repo types from their folders", () => {
    expect(
      repoTypesIn(["spring-service", ".git", "notes.md", "apigee-proxy"], (n) => n !== "notes.md"),
    ).toEqual(["apigee-proxy", "spring-service"]);
  });
});

describe("doctor --counts, safe to paste (F10)", () => {
  it("shows what it printed whole, and offers it on the clipboard", () => {
    const j = jobByCommand("atticus.doctorCounts")!;
    expect(jobArgv(j, {})).toEqual(["doctor", "--counts"]);
    expect(j.how).toBe("report");
    expect(j.copy).toBe(true);
  });
});

describe("@atticus routes beta.11's plain requests", () => {
  it.each([
    ["which contracts mismatch?", "atticus.contractMismatches"],
    ["show me the payload mismatches", "atticus.contractMismatches"],
    ["give me the counts, safe to paste", "atticus.doctorCounts"],
    ["draft rules from the notes", "atticus.repoTypeRules"],
    ["what notes does spring-service have?", "atticus.repoTypeNotes"],
  ])("%s", (prompt, command) => {
    expect(routeAsk(prompt)?.command).toBe(command);
  });

  it("keeps every job's command unique", () => {
    const ids = JOBS.map((j) => j.command);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
