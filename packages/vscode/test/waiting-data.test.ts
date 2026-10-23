import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Cli, CliResult, OpenQuestion } from "../src/types";
import {
  isUnverified,
  readWaiting,
  waitingRows,
  type WaitingRead,
  type WaitingRow,
} from "../src/waiting-data";

/**
 * ADR 0105: the Waiting on you section, what waits on a person across every change: the open
 * questions, the open needs, the manual steps to do, the open findings and the knowledge no one
 * has verified. The command line's JSON is canned here (the invented Forge ecosystem); no
 * process runs and nothing is read from the network.
 */

const ROOT = join("/", "forge-metarepo");
const ok = (v: unknown): CliResult => ({
  code: 0,
  stdout: JSON.stringify(v),
  stderr: "",
  cancelled: false,
});
const failed = (stderr: string): CliResult => ({ code: 1, stdout: "", stderr, cancelled: false });

const need = (o: Record<string, unknown>) => ({
  change: "add-note-tags",
  item: "request-kafka-topic",
  kind: "request",
  title: "Request a Kafka topic",
  for: "change",
  why: "The change publishes note.tagged.",
  from: "assistant",
  leadTime: "3 days",
  handledBy: "Platform team",
  status: "open",
  ...o,
});

const CANNED: Record<string, CliResult> = {
  "needs --all --json": ok([
    need({}),
    need({ item: "standard-api-versioning", title: "Version the API", status: "done" }),
    need({
      change: "northwind-refunds",
      item: "vendor-northwind-pay",
      kind: "vendor",
      title: "Tell Northwind Pay",
      leadTime: undefined,
      handledBy: "Payments team",
    }),
  ]),
  "todo --json": ok([
    {
      id: "step-1",
      change: "northwind-refunds",
      system: "northwind-pay-console",
      action: "configure",
      state: "open",
      title: "Turn on refunds in the Northwind Pay console",
      where: "Northwind Pay console, Settings",
      waitsFor: [],
      record: [],
      createdAt: "2026-10-20T09:00:00Z",
    },
    {
      id: "step-2",
      change: "northwind-refunds",
      system: "forge-ledger",
      action: "configure",
      state: "open",
      title: "Add the refunds account to forge-ledger",
      waitsFor: ["step-1"],
      record: [],
      createdAt: "2026-10-20T09:00:00Z",
    },
  ]),
  "change list --json": ok([
    { id: "add-note-tags", title: "Add tags to notes", type: "feature", state: "design" },
    {
      id: "northwind-refunds",
      title: "Refunds through Northwind Pay",
      type: "feature",
      state: "plan",
    },
    { id: "old-ledger-fix", title: "An old ledger fix", type: "bugfix", state: "released" },
  ]),
  "findings add-note-tags --json": ok([
    {
      gate: "design",
      round: 1,
      open: 2,
      findings: [
        {
          id: "f-1",
          kind: "gap",
          change: "add-note-tags",
          severity: "gap",
          artifact: "design.md",
          summary: "Who may tag a note isn't said",
          why: "The brief names editors only.",
          fix: { text: "Say who may tag a note." },
          state: "open",
          path: "openspec/changes/add-note-tags/findings/f-1.yaml",
        },
        {
          id: "f-2",
          kind: "rule",
          change: "add-note-tags",
          severity: "blocking",
          artifact: "design.md",
          summary: "The tags table has no owner",
          why: "Every table names its owner.",
          fix: { text: "Name the owner." },
          state: "open",
          path: "openspec/changes/add-note-tags/findings/f-2.yaml",
        },
        {
          id: "f-3",
          kind: "rule",
          change: "add-note-tags",
          severity: "risk",
          artifact: "design.md",
          summary: "Already applied",
          why: "",
          fix: { text: "" },
          state: "applied",
          path: "openspec/changes/add-note-tags/findings/f-3.yaml",
        },
      ],
    },
  ]),
  "findings northwind-refunds --json": ok([]),
  "knowledge list --json": ok([
    { id: "request-kafka-topic", kind: "knowledge", review: { state: "verified", by: "@ana" } },
    { id: "vendor-northwind-pay", kind: "knowledge" },
    { id: "standard-api-versioning", kind: "knowledge", review: { state: "stale" } },
    { id: "team-platform", kind: "knowledge", review: { state: "rejected", by: "@ana" } },
    { id: "team-payments", kind: "knowledge", review: { state: "corrected", by: "@ana" } },
  ]),
};

/** A command line that answers from CANNED, and remembers what it was asked. */
function fakeCli(over: Record<string, CliResult> = {}) {
  const asked: string[] = [];
  const cli: Cli = async (args) => {
    const at = args.indexOf("--root");
    expect(args[at + 1]).toBe(ROOT);
    const key = args.slice(0, at).join(" ");
    asked.push(key);
    const r = over[key] ?? CANNED[key];
    if (!r) throw new Error(`not canned: ${key}`);
    return r;
  };
  return { cli, asked };
}

const NEEDS_MD = [
  "# What add-note-tags needs",
  "",
  "- [ ] **Request a Kafka topic** (the whole change): 3 days, Platform team",
].join("\n");
const files = {
  exists: (p: string) => p === join(ROOT, "openspec", "changes", "add-note-tags", "needs.yaml"),
  read: (p: string) =>
    p === join(ROOT, "openspec", "changes", "add-note-tags", "needs.md") ? NEEDS_MD : undefined,
};

const QUESTIONS: OpenQuestion[] = [
  {
    id: "q-1",
    repo: "forge-ledger",
    question: "Which team owns the ledger's refunds table?",
    options: [{ label: "Payments" }, { label: "Platform" }],
    evidence: [],
  },
  {
    id: "q-2",
    repo: "forge-notes",
    question: "Is note.tagged read outside forge-notes?",
    options: [],
    evidence: [],
  },
];

const labels = (rows: WaitingRow[]) => rows.map((r) => r.label);
const group = (rows: WaitingRow[], id: string) => rows.find((r) => r.id === `waiting:${id}`)!;

describe("what waits on a person, read (ADR 0105)", () => {
  it("reads the open needs, the manual steps, each open change's findings and the knowledge", async () => {
    const { cli, asked } = fakeCli();
    const w = await readWaiting(cli, ROOT, files);
    expect(asked).toEqual(
      expect.arrayContaining([
        "needs --all --json",
        "todo --json",
        "change list --json",
        "findings add-note-tags --json",
        "findings northwind-refunds --json",
        "knowledge list --json",
      ]),
    );
    // A released change's findings aren't read: nothing waits on it.
    expect(asked).not.toContain("findings old-ledger-fix --json");
    expect(Array.isArray(w.needs) && w.needs.map((n) => n.title)).toEqual([
      "Request a Kafka topic",
      "Tell Northwind Pay",
    ]);
    expect(Array.isArray(w.todo) && w.todo.map((t) => t.id)).toEqual(["step-1", "step-2"]);
    expect(Array.isArray(w.findings) && w.findings.map((f) => f.id)).toEqual(["f-1", "f-2"]);
    expect(w.unverified).toBe(2);
    expect(w.titles["northwind-refunds"]).toBe("Refunds through Northwind Pay");
    expect(w.needsMd["add-note-tags"]).toEqual({
      path: join(ROOT, "openspec", "changes", "add-note-tags", "needs.md"),
      text: NEEDS_MD,
    });
  });

  it("keeps each part's reason when it can't be read, and reads the others", async () => {
    const { cli } = fakeCli({
      "todo --json": failed("The steps folder is unreadable.\nmore"),
      "findings add-note-tags --json": failed("add-note-tags has no change.yaml"),
    });
    const w = await readWaiting(cli, ROOT, files);
    expect(w.todo).toBe("The steps folder is unreadable.");
    expect(w.findings).toBe("add-note-tags has no change.yaml");
    expect(Array.isArray(w.needs)).toBe(true);
  });

  it("counts no knowledge to verify when there are no knowledge items yet", async () => {
    const { cli } = fakeCli({ "knowledge list --json": failed("No knowledge items yet.") });
    expect((await readWaiting(cli, ROOT, files)).unverified).toBe(0);
  });

  it("counts as unverified what no person verified, corrected or rejected", () => {
    expect(isUnverified({})).toBe(true);
    expect(isUnverified({ review: { state: "stale" } } as never)).toBe(true);
    for (const state of ["verified", "corrected", "rejected"])
      expect(isUnverified({ review: { state } } as never)).toBe(false);
  });
});

describe("the Waiting on you rows, by kind (ADR 0105)", () => {
  const read = async () => readWaiting(fakeCli().cli, ROOT, files);

  it("has a group for each kind, in order, each with its count", async () => {
    const rows = waitingRows(QUESTIONS, await read(), "kind");
    expect(labels(rows)).toEqual([
      "Questions",
      "Needs",
      "Manual steps",
      "Findings",
      "Knowledge to verify",
    ]);
    expect(rows.map((r) => r.description)).toEqual([
      "2 to answer",
      "2 open",
      "2 to do",
      "2 open",
      "2 items",
    ]);
  });

  it("keeps the questions by repo, each answered with a click", async () => {
    const q = group(waitingRows(QUESTIONS, await read(), "kind"), "questions");
    expect(labels(q.rows!)).toEqual(["forge-ledger", "forge-notes"]);
    const repo = q.rows![0]!;
    expect(repo.context).toBe("atticus.questionRepo");
    expect(repo.questions?.map((x) => x.id)).toEqual(["q-1"]);
    expect(repo.rows![0]).toMatchObject({
      label: "Which team owns the ledger's refunds table?",
      description: "2 options",
      command: { command: "atticus.answerQuestion", args: ["q-1"] },
    });
  });

  it("lists every open need, naming its change, with Done and Not needed on each", async () => {
    const n = group(waitingRows([], await read(), "kind"), "needs");
    expect(labels(n.rows!)).toEqual(["Request a Kafka topic", "Tell Northwind Pay"]);
    const [kafka, northwind] = n.rows!;
    expect(kafka!.description).toBe("Add tags to notes · for the change · 3 days · Platform team");
    // The same context as a change's need rows, so Done and Not needed show on it.
    expect(kafka!.context).toBe("atticus.need.open");
    expect(kafka!.need?.item).toBe("request-kafka-topic");
    // It opens the need in needs.md, at its line.
    expect(kafka!.open).toEqual({
      kind: "file",
      path: join(ROOT, "openspec", "changes", "add-note-tags", "needs.md"),
      line: 3,
    });
    expect(northwind!.description).toBe(
      "Refunds through Northwind Pay · for the change · Payments team",
    );
  });

  it("lists the manual steps to do, each opening the step", async () => {
    const t = group(waitingRows([], await read(), "kind"), "todo");
    expect(t.rows!.map((r) => [r.label, r.description, r.icon, r.command])).toEqual([
      [
        "Turn on refunds in the Northwind Pay console",
        "Refunds through Northwind Pay · northwind-pay-console",
        "circle-large-outline",
        { command: "atticus.showManualStep", args: ["northwind-refunds/step-1"] },
      ],
      [
        "Add the refunds account to forge-ledger",
        "Refunds through Northwind Pay · forge-ledger · after step-1",
        "lock",
        { command: "atticus.showManualStep", args: ["northwind-refunds/step-2"] },
      ],
    ]);
  });

  it("lists the open findings, blocking first, each opening its change", async () => {
    const f = group(waitingRows([], await read(), "kind"), "findings");
    expect(labels(f.rows!)).toEqual([
      "The tags table has no owner",
      "Who may tag a note isn't said",
    ]);
    expect(f.rows![0]).toMatchObject({
      description: "Add tags to notes · blocking",
      icon: "error",
      context: "atticus.finding",
      open: { kind: "app", hash: "#/changes/add-note-tags" },
    });
    expect(f.rows![0]!.finding?.id).toBe("f-2");
  });

  it("opens Check what no one has verified from the knowledge to verify", async () => {
    const k = group(waitingRows([], await read(), "kind"), "knowledge");
    expect(k.rows).toBeUndefined();
    expect(k.command).toEqual({ command: "atticus.reviewUnverified" });
  });

  it("leaves out an empty group", () => {
    const w: WaitingRead = {
      needs: [],
      needsMd: {},
      todo: [],
      findings: [],
      titles: {},
      unverified: 3,
    };
    expect(labels(waitingRows(QUESTIONS, w, "kind"))).toEqual(["Questions", "Knowledge to verify"]);
  });

  it("says so in one row when nothing waits", () => {
    const w: WaitingRead = {
      needs: [],
      needsMd: {},
      todo: [],
      findings: [],
      titles: {},
      unverified: 0,
    };
    const rows = waitingRows([], w, "kind");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "Nothing waits on you.", icon: "check" });
  });

  it("says why a part couldn't be read, in its place, with the output a click away", () => {
    const w: WaitingRead = {
      needs: "needs.yaml is broken",
      needsMd: {},
      todo: [],
      findings: [],
      titles: {},
      unverified: 0,
    };
    const rows = waitingRows("Couldn't read the questions: no metarepo", w, "kind");
    expect(rows.map((r) => [r.label, r.icon, r.command?.command])).toEqual([
      ["Couldn't read the questions: no metarepo", "warning", "atticus.showLog"],
      ["Couldn't read the needs: needs.yaml is broken", "warning", "atticus.showLog"],
    ]);
  });
});

describe("the Waiting on you rows, by change (ADR 0105 addendum)", () => {
  // A manual step that belongs to no change.
  const TODO_ALONE = {
    id: "step-3",
    system: "forge-ledger",
    action: "configure",
    state: "open",
    title: "Rotate the forge-ledger signing key",
    waitsFor: [],
    record: [],
    createdAt: "2026-10-21T09:00:00Z",
  };
  const todo = JSON.parse(CANNED["todo --json"]!.stdout) as unknown[];
  const read = async (over: Record<string, CliResult> = {}) =>
    readWaiting(fakeCli({ "todo --json": ok([...todo, TODO_ALONE]), ...over }).cli, ROOT, files);
  const kids = (r: WaitingRow) => (r.rows ?? []).map((x) => x.label);

  it("is the default", async () => {
    const w = await read();
    expect(waitingRows(QUESTIONS, w)).toEqual(waitingRows(QUESTIONS, w, "change"));
  });

  it("lists each change with something open, its title, id and count, then what belongs to none", async () => {
    const rows = waitingRows(QUESTIONS, await read());
    expect(rows.map((r) => [r.id, r.label, r.description])).toEqual([
      [
        "waiting:change:add-note-tags",
        "Add tags to notes",
        "add-note-tags · 3 waiting · 1 blocking",
      ],
      [
        "waiting:change:northwind-refunds",
        "Refunds through Northwind Pay",
        "northwind-refunds · 3 waiting",
      ],
      ["waiting:other", "Not part of a change", "5 waiting"],
    ]);
    expect(rows[0]!.icon).toBe("error");
    expect(rows[1]!.icon).toBe("git-pull-request");
  });

  it("puts under a change its open needs, then its open findings, then its manual steps", async () => {
    const [notes, refunds] = waitingRows([], await read());
    expect(kids(notes!)).toEqual([
      "Request a Kafka topic",
      "The tags table has no owner",
      "Who may tag a note isn't said",
    ]);
    expect(kids(refunds!)).toEqual([
      "Tell Northwind Pay",
      "Turn on refunds in the Northwind Pay console",
      "Add the refunds account to forge-ledger",
    ]);
  });

  it("keeps each row's actions and context, without naming the change it is under", async () => {
    const [notes, refunds] = waitingRows([], await read());
    const [kafka, blocking] = notes!.rows!;
    expect(kafka).toMatchObject({
      context: "atticus.need.open",
      description: "for the change · 3 days · Platform team",
      open: { kind: "file", line: 3 },
    });
    expect(kafka!.need?.item).toBe("request-kafka-topic");
    expect(blocking).toMatchObject({
      description: "blocking",
      context: "atticus.finding",
      open: { kind: "app", hash: "#/changes/add-note-tags" },
    });
    expect(refunds!.rows![2]).toMatchObject({
      description: "forge-ledger · after step-1",
      icon: "lock",
      command: { command: "atticus.showManualStep", args: ["northwind-refunds/step-2"] },
    });
  });

  it("puts a change with a blocking finding first, then the rest by title", async () => {
    const blockingOnRefunds = ok([
      {
        gate: "plan",
        round: 1,
        open: 1,
        findings: [
          {
            id: "f-9",
            kind: "rule",
            change: "northwind-refunds",
            severity: "blocking",
            artifact: "plan.md",
            summary: "The refunds limit isn't said",
            why: "",
            fix: { text: "" },
            state: "open",
            path: "openspec/changes/northwind-refunds/findings/f-9.yaml",
          },
        ],
      },
    ]);
    const rows = waitingRows(
      [],
      await read({
        "findings northwind-refunds --json": blockingOnRefunds,
        "findings add-note-tags --json": ok([]),
      }),
    );
    expect(labels(rows)).toEqual([
      "Refunds through Northwind Pay",
      "Add tags to notes",
      "Not part of a change",
    ]);
  });

  it("puts the questions by repo, manual steps with no change and knowledge to verify in its own group", async () => {
    const other = waitingRows(QUESTIONS, await read()).at(-1)!;
    expect(kids(other)).toEqual(["Questions", "Manual steps", "Knowledge to verify"]);
    const [q, steps, knowledge] = other.rows!;
    expect(kids(q!)).toEqual(["forge-ledger", "forge-notes"]);
    expect(q!.rows![0]!.context).toBe("atticus.questionRepo");
    expect(steps).toMatchObject({ id: "waiting:todo", description: "1 to do" });
    expect(steps!.rows![0]).toMatchObject({
      label: "Rotate the forge-ledger signing key",
      command: { command: "atticus.showManualStep", args: ["step-3"] },
    });
    expect(knowledge!.command).toEqual({ command: "atticus.reviewUnverified" });
  });

  it("leaves out the group of what belongs to no change when it is empty", async () => {
    const rows = waitingRows(
      [],
      await read({ "todo --json": CANNED["todo --json"]!, "knowledge list --json": ok([]) }),
    );
    expect(labels(rows)).toEqual(["Add tags to notes", "Refunds through Northwind Pay"]);
  });

  it("says so in one row when nothing waits, and why a part couldn't be read, first", () => {
    const none: WaitingRead = {
      needs: [],
      needsMd: {},
      todo: [],
      findings: [],
      titles: {},
      unverified: 0,
    };
    expect(labels(waitingRows([], none))).toEqual(["Nothing waits on you."]);
    const rows = waitingRows([], { ...none, findings: "add-note-tags has no change.yaml" });
    expect(rows.map((r) => [r.label, r.command?.command])).toEqual([
      ["Couldn't read the findings: add-note-tags has no change.yaml", "atticus.showLog"],
    ]);
  });
});
