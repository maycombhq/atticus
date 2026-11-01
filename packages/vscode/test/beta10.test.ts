import { describe, expect, it } from "vitest";
import {
  actionFor,
  answerQuestion,
  readMyQuestions,
  readOpenQuestions,
  readQueue,
  takesRule,
} from "../src/atticus";
import { JOBS, jobArgv, jobByCommand, routeAsk, renameHint, queueRow } from "../src/jobs";
import { nextRow } from "../src/next-rows";
import { questionsRows } from "../src/waiting-data";
import { stepTitle, WORDS } from "../src/words";
import type { Cli, CliResult, NextStep, OpenQuestion } from "../src/types";

/**
 * What beta.10 added to the command line and the app, caught up in the extension: the new jobs
 * in the palette, the Questions view's owners, order, My teams' filter, proposals and rules, the
 * Next view's onboarding queue, re-read and accept-seed steps and near repo ids, and @atticus's
 * routing of plain requests to them. No VS Code: a fake command line answers.
 */

const ok = (stdout: unknown): CliResult => ({
  code: 0,
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

const Q = (id: string, repo: string, extra: Partial<OpenQuestion> = {}): OpenQuestion => ({
  id,
  repo,
  question: `Which repo answers on ${id}?`,
  options: [{ label: "forge-ledger" }, { label: "An outside system (new)" }],
  evidence: [`${repo}/src/client.ts:4`],
  ...extra,
});

const LIST = {
  questions: [
    { ...Q("q-2", "forge-notes"), askedBy: { step: "facts-targets", command: "verify" } },
    { ...Q("q-1", "forge-ledger"), askedBy: { step: "scan-survey", command: "scan survey" } },
    { ...Q("q-3", "forge-notes"), askedBy: { step: "scan-hosts", command: "verify" } },
  ],
  problems: [],
  about: {
    "q-2": {
      restsOn: ["add-pins"],
      joins: 3,
      owner: { team: "notes", name: "Notes team" },
      proposal: {
        answer: { option: 1 },
        why: "The client's base URL is the ledger's.",
        cites: [{ file: "src/client.ts", line: 4, quote: "LEDGER_URL" }],
        by: "Copilot",
        at: "2026-10-31T10:00:00Z",
        file: "proposals/questions/q-2.yaml",
      },
    },
    "q-1": { restsOn: [], joins: 0, owner: { none: "the manifest names no owner" } },
    "q-3": {
      restsOn: [],
      joins: 1,
      owner: { change: "add-pins", people: ["ana", "raj"] },
    },
  },
};

describe("the open questions, as beta.10 lists them", () => {
  it("keeps each question's owner, what rests on it and its checked proposal", async () => {
    const { cli } = fakeCli(() => ok(LIST));
    const r = await readOpenQuestions(cli, "/m");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((q) => q.id)).toEqual(["q-2", "q-1", "q-3"]);
    expect(r.value[0]!.about?.owner).toEqual({ team: "notes", name: "Notes team" });
    expect(r.value[0]!.about?.proposal?.answer).toEqual({ option: 1 });
    expect(r.value[0]!.askedBy?.step).toBe("facts-targets");
  });

  it("reads My teams' questions with --mine, and who the person is", async () => {
    const { cli, asked } = fakeCli(() =>
      ok({
        ...LIST,
        questions: [LIST.questions[0]],
        me: { handle: "ana", teams: [{ id: "notes" }] },
      }),
    );
    const r = await readMyQuestions(cli, "/m");
    expect(asked[0]).toEqual([
      "questions",
      "list",
      "--state",
      "open",
      "--mine",
      "--json",
      "--root",
      "/m",
    ]);
    expect(r.ok && r.value.me).toEqual({ handle: "ana", teams: [{ id: "notes" }] });
    expect(r.ok && r.value.questions.map((q) => q.id)).toEqual(["q-2"]);
  });

  it("answers by rule with --match, and accepts a proposal with --accept-proposal", async () => {
    const { cli, asked } = fakeCli(() => ok("Answered q-2."));
    await answerQuestion(cli, "/m", "q-2", { option: 1 }, { match: "*.payments.forge.internal" });
    await answerQuestion(cli, "/m", "q-2", { acceptProposal: true });
    expect(asked[0]).toEqual([
      "questions",
      "answer",
      "q-2",
      "--option",
      "1",
      "--match",
      "*.payments.forge.internal",
      "--root",
      "/m",
    ]);
    expect(asked[1]).toEqual(["questions", "answer", "q-2", "--accept-proposal", "--root", "/m"]);
  });

  it("offers a rule only to a target or hosts question", () => {
    expect(takesRule({ askedBy: { step: "facts-targets" } })).toBe(true);
    expect(takesRule({ askedBy: { step: "scan-hosts" } })).toBe(true);
    expect(takesRule({ askedBy: { step: "scan-survey" } })).toBe(false);
    expect(takesRule({})).toBe(false);
  });
});

describe("the Questions view, in the order to ask them", () => {
  const read = (LIST.questions as OpenQuestion[]).map((q) => ({
    ...q,
    about: (LIST.about as Record<string, OpenQuestion["about"]>)[q.id],
  }));

  it("keeps the command line's order: the repo of what a change rests on first", () => {
    const rows = questionsRows(read);
    expect(rows.map((r) => r.label)).toEqual(["forge-notes", "forge-ledger"]);
    expect(rows[0]!.rows!.map((r) => r.id)).toEqual(["question:q-2", "question:q-3"]);
  });

  it("names each question's owner and the change that rests on it", () => {
    const [notes, ledger] = questionsRows(read);
    const q2 = notes!.rows![0]!;
    expect(q2.description).toContain("Notes team");
    expect(q2.description).toContain(WORDS.restsOnShort("add-pins"));
    expect(q2.tooltip).toContain(WORDS.questionJoins(3));
    expect(notes!.rows![1]!.description).toContain("ana, raj");
    expect(ledger!.rows![0]!.description).toContain(WORDS.noOwner);
  });

  it("shows a checked proposal with Accept as my answer, which runs --accept-proposal", () => {
    const q2 = questionsRows(read)[0]!.rows![0]!;
    expect(q2.context).toBe("atticus.questionProposed");
    expect(q2.tooltip).toContain("src/client.ts:4");
    const accept = q2.rows![0]!;
    expect(accept.label).toBe(WORDS.acceptAsMine("1. forge-ledger"));
    expect(accept.command).toEqual({ command: "atticus.acceptProposal", args: ["q-2"] });
    // A question with no proposal opens and closes nothing.
    expect(questionsRows(read)[0]!.rows![1]!.rows).toBeUndefined();
  });

  it("says a target or hosts question can be answered by rule", () => {
    const [notes, ledger] = questionsRows(read);
    expect(notes!.rows![0]!.tooltip).toContain(WORDS.ruleHint);
    expect(ledger!.rows![0]!.tooltip).not.toContain(WORDS.ruleHint);
  });

  it("heads My teams' questions with the person's teams, and says when they are on none", () => {
    const mine = questionsRows(read.slice(0, 1), {
      me: { handle: "ana", teams: [{ id: "notes", name: "Notes team" }] },
    });
    expect(mine[0]).toMatchObject({
      id: "questions:mine",
      label: WORDS.myTeams("ana", ["notes (Notes team)"]),
    });
    expect(mine[0]!.command).toEqual({ command: "atticus.questionsAll" });
    const none = questionsRows([], { me: { handle: "ana", teams: [] } });
    expect(none.map((r) => r.label)).toEqual([WORDS.myTeams("ana", []), WORDS.noQuestionsMine]);
  });
});

describe("the Next view's beta.10 steps", () => {
  const reread: NextStep = {
    step: "reread",
    command: "atticus map forge-ledger",
    slash: "/atticus-map forge-ledger",
    why: "forge-ledger's clone moved past its facts' commit.",
    repo: "forge-ledger",
  };
  const seed: NextStep = {
    step: "accept-seed",
    command: "atticus spec accept forge-notes",
    why: "add-pins adds note-pin as new, and forge-notes's starting spec adds it too.",
    person: true,
    change: "add-pins",
    repo: "forge-notes",
  };

  it("says the re-read and the accept-seed steps in plain words", () => {
    expect(stepTitle(reread)).toBe("Read forge-ledger again: its clone moved past its facts");
    expect(stepTitle(seed)).toBe("Read and accept forge-notes's starting spec");
    // The re-read is a read with Copilot; accepting the seed is a person's.
    expect(actionFor(reread).kind).toBe("ai");
    expect(actionFor(seed).kind).toBe("person");
  });

  it("plans the gaps without a model: map --gaps only writes the second pass's prompt", () => {
    expect(actionFor({ step: "x", command: "atticus map forge-ledger --gaps", why: "" })).toEqual({
      kind: "run",
      args: ["map", "forge-ledger", "--gaps"],
    });
  });

  it("reads the onboarding queue, each repo with its reason and its cost", async () => {
    const { cli, asked } = fakeCli(() =>
      ok({
        queue: [
          {
            repo: "forge-gateway",
            order: 1,
            reason: "gateway",
            why: "A gateway: its routes place the others.",
            command: "atticus map forge-gateway",
            cost: { estimated: { tokens: 61000, sessions: 2 } },
          },
          {
            repo: "forge-web",
            order: 2,
            reason: "rest",
            why: "The rest.",
            command: "atticus map forge-web",
          },
        ],
        read: [],
        problems: [],
      }),
    );
    const r = await readQueue(cli, "/m");
    expect(asked[0]).toEqual(["next", "--queue", "--json", "--root", "/m"]);
    expect(r.ok && r.value.map((x) => x.repo)).toEqual(["forge-gateway", "forge-web"]);
    if (!r.ok) return;
    const row = queueRow(r.value[0]!);
    expect(row.label).toBe("1. forge-gateway");
    expect(row.description).toContain("gateway");
    expect(row.description).toContain("61K tokens");
    expect(row.tooltip).toContain("A gateway: its routes place the others.");
    expect(queueRow(r.value[1]!).description).toContain(WORDS.notEstimated);
    expect(row.command).toEqual({
      command: "atticus.runStep",
      title: "Read it",
      args: [
        {
          step: "map",
          command: "atticus map forge-gateway",
          why: "A gateway: its routes place the others.",
          repo: "forge-gateway",
        },
      ],
    });
  });

  it("draws the queue as a row that opens the list", () => {
    const r = nextRow({ kind: "queue", repos: 3 });
    expect(r.label).toBe(WORDS.queueHead(3));
    expect(r.expanded).toBe(false);
    expect(nextRow({ kind: "queue-repo", row: { label: "1. a", icon: "repo" } }).label).toBe(
      "1. a",
    );
  });

  it("offers to rename a repo whose id is near one that has facts", () => {
    const step: NextStep = {
      step: "map",
      command: "atticus map forge_ledger",
      why: "forge_ledger isn't read yet. No facts are filed under forge_ledger, but forge-ledger has some (facts/forge-ledger.jsonl) and its id is near this one: if they are one repo, keep one id with atticus repo rename forge_ledger forge-ledger (or rename the facts to forge_ledger).",
      repo: "forge_ledger",
    };
    expect(renameHint(step)).toEqual({ from: "forge_ledger", to: "forge-ledger" });
    expect(renameHint({ ...step, why: "forge_ledger isn't read yet." })).toBeUndefined();
    const r = nextRow({ kind: "hint", from: "forge_ledger", to: "forge-ledger" });
    expect(r.label).toBe(WORDS.nearIdHint("forge_ledger", "forge-ledger"));
    expect(r.command).toEqual({
      command: "atticus.repoRename",
      title: WORDS.renameRepo,
      args: ["forge_ledger", "forge-ledger"],
    });
  });
});

describe("the new jobs in the palette", () => {
  it("runs each job as the command line has it", () => {
    const a = { repo: "forge-ledger", change: "add-pins", file: "/m/ref.yaml" };
    const argv = (c: string, x: Parameters<typeof jobArgv>[1] = a) => jobArgv(jobByCommand(c)!, x);
    expect(argv("atticus.estateFresh")).toEqual(["estate", "fresh"]);
    expect(argv("atticus.nextQueue")).toEqual(["next", "--queue"]);
    expect(argv("atticus.mapGaps")).toEqual(["map", "forge-ledger", "--gaps"]);
    expect(argv("atticus.joinMeasure")).toEqual(["join", "measure", "/m/ref.yaml"]);
    expect(argv("atticus.auditReport")).toEqual(["verify", "audit", "forge-ledger", "--report"]);
    expect(argv("atticus.auditReport", {})).toEqual(["verify", "audit", "--report"]);
    expect(argv("atticus.changeImpact")).toEqual(["change", "impact", "add-pins"]);
    expect(argv("atticus.specSeed")).toEqual(["spec", "seed", "forge-ledger"]);
    expect(argv("atticus.specAccept")).toEqual(["spec", "accept", "forge-ledger"]);
    expect(argv("atticus.questionsSheet")).toEqual(["questions", "sheet"]);
    expect(argv("atticus.questionsApply")).toEqual([
      "questions",
      "sheet",
      "--apply",
      "/m/ref.yaml",
    ]);
    expect(argv("atticus.questionsProposed")).toEqual(["questions", "proposed"]);
    expect(argv("atticus.intakeTraffic", { file: "/x/export.json", source: "apigee" })).toEqual([
      "intake",
      "traffic",
      "/x/export.json",
      "--source",
      "apigee",
    ]);
    expect(argv("atticus.repoRename", { old: "forge_ledger", new: "forge-ledger" })).toEqual([
      "repo",
      "rename",
      "forge_ledger",
      "forge-ledger",
    ]);
  });

  it("asks a person before the jobs that move or archive files, and shows reports in a tab", () => {
    const how = (c: string) => jobByCommand(c)!.how;
    expect(how("atticus.specAccept")).toBe("confirm");
    expect(how("atticus.repoRename")).toBe("confirm");
    for (const c of [
      "atticus.estateFresh",
      "atticus.nextQueue",
      "atticus.joinMeasure",
      "atticus.auditReport",
      "atticus.changeImpact",
      "atticus.questionsProposed",
    ])
      expect(how(c), c).toBe("report");
  });

  it("points each to its app page, and the gaps and proposals to Copilot Chat", () => {
    expect(jobByCommand("atticus.estateFresh")!.app?.({})).toBe("#/trust");
    expect(jobByCommand("atticus.auditReport")!.app?.({})).toBe("#/trust");
    expect(jobByCommand("atticus.changeImpact")!.app?.({ change: "add-pins" })).toBe(
      "#/architecture?change=add-pins",
    );
    expect(jobByCommand("atticus.mapGaps")!.chat?.({ repo: "forge-ledger" })).toEqual({
      step: "map",
      target: "forge-ledger --gaps",
    });
    expect(jobByCommand("atticus.propose")!.chat?.({})).toEqual({ step: "propose" });
  });

  it("has a title and a unique command for every job", () => {
    expect(new Set(JOBS.map((j) => j.command)).size).toBe(JOBS.length);
    for (const j of JOBS) expect(j.title.length, j.command).toBeGreaterThan(5);
  });
});

describe("@atticus routes a plain request to the right job", () => {
  it.each([
    ["why is this linked?", "atticus.diagram"],
    ["what does this change break", "atticus.changeImpact"],
    ["which repos are stale?", "atticus.estateFresh"],
    ["propose answers to the open questions", "atticus.propose"],
    ["what should I read next, in what order", "atticus.nextQueue"],
    ["plan a second pass on the gaps of forge-ledger", "atticus.mapGaps"],
    ["how precise is the audit", "atticus.auditReport"],
    ["measure the join against my reference", "atticus.joinMeasure"],
    ["seed a spec for forge-notes", "atticus.specSeed"],
    ["accept the seed", "atticus.specAccept"],
    ["an answer sheet for every question", "atticus.questionsSheet"],
    ["bring in a traffic export", "atticus.intakeTraffic"],
    ["rename the repo id", "atticus.repoRename"],
    ["which questions are mine?", "atticus.questionsMine"],
  ])("%s", (prompt, command) => {
    expect(routeAsk(prompt)?.command).toBe(command);
  });

  it("names the repo or change it finds in the request, and leaves the rest to /next", () => {
    expect(routeAsk("what does add-pins break?", { changes: ["add-pins"] })).toMatchObject({
      command: "atticus.changeImpact",
      args: { change: "add-pins" },
    });
    expect(routeAsk("gaps in forge-ledger", { repos: ["forge-ledger"] })?.args).toEqual({
      repo: "forge-ledger",
    });
    expect(routeAsk("hello there")).toBeUndefined();
  });
});
