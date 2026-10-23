import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import {
  FilterBox,
  FilterCount,
  FilterEmpty,
  filteredWhat,
  matchesWords,
} from "../src/app/filter.js";
import { inboxOf, waitingByChange, type InboxData } from "../src/app/inbox.js";
import { WaitingList } from "../src/screens/CommandCenter.js";
import { QuestionList, questionRepos, shownQuestions } from "../src/screens/Questions.js";
import { matchStep } from "../src/screens/run/Todo.js";
import { ItemList } from "../src/screens/knowledge/Items.js";
import type { QuestionView } from "../src/screens/Questions.js";

/**
 * ADR 0105 addendum: what needs a person grouped by change, and one filter box wherever a list
 * grows. Everything is the invented Forge estate (CLAUDE.md rule 3).
 */

const F = COPY.filter;
const T = COPY.commandCenter;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

describe("the filter box", () => {
  it("matches every word, case aside, in any of the fields", () => {
    expect(matchesWords(["Network firewall rule", "add-transfer-limit"], "")).toBe(true);
    expect(matchesWords(["Network firewall rule", "add-transfer-limit"], "  ")).toBe(true);
    expect(matchesWords(["Network firewall rule", "add-transfer-limit"], "FIREWALL transfer")).toBe(
      true,
    );
    expect(matchesWords(["Network firewall rule", undefined], "firewall ledger")).toBe(false);
    // Words match within a field, not across two.
    expect(matchesWords(["forge", "ledger"], "forgeledger")).toBe(false);
  });

  it("has a label, the shared placeholder, and a polite count", () => {
    const box = html(<FilterBox id="f" value="ledger" onChange={() => {}} />);
    expect(box).toContain('<label for="f"');
    expect(box).toContain(`>${F.label}</label>`);
    expect(box).toContain(`placeholder="${F.placeholder}"`);
    expect(box).toContain('value="ledger"');
    const count = html(<FilterCount shown={2} total={5} active />);
    expect(count).toContain('aria-live="polite"');
    expect(count).toContain(F.shown(2, 5));
    // The live region is there before a filter is typed, so the first count is announced.
    const idle = html(<FilterCount shown={5} total={5} active={false} />);
    expect(idle).toContain('aria-live="polite"');
    expect(idle).not.toContain(F.shown(5, 5));
  });

  it("says what was filtered, with a button to clear it", () => {
    expect(filteredWhat({ text: " ledger " })).toBe(F.words("ledger"));
    expect(filteredWhat({ text: "ledger", repo: "forge-notes" })).toBe(
      `${F.words("ledger")} ${F.inRepo("forge-notes")}`,
    );
    const out = html(<FilterEmpty what={filteredWhat({ text: "ledger" })} onClear={() => {}} />);
    expect(out).toContain(esc(F.nothingMatches(F.words("ledger"))));
    expect(out).toContain(`<button type="button" class="btn">${F.clear}</button>`);
  });
});

const changes = [
  { id: "add-transfer-limit", title: "Add a daily transfer limit", type: "feature", state: "plan" },
  {
    id: "fix-northwind-timeout",
    title: "Fix the Northwind timeout",
    type: "bug-fix",
    state: "build",
  },
  { id: "quiet-change", title: "A change with nothing open", type: "feature", state: "define" },
];
const data: InboxData = {
  changes,
  findings: [
    {
      id: "b1",
      gate: "build",
      severity: "blocking",
      artifact: "tasks.md",
      summary: "No retry on the Northwind call",
      state: "open",
      change: "fix-northwind-timeout",
    },
    {
      id: "g1",
      gate: "define",
      severity: "gap",
      artifact: "brief.md",
      summary: "No measure for the outcome",
      state: "open",
      change: "add-transfer-limit",
    },
  ],
  questions: [
    { id: "q1", question: "Who owns audit-svc?", owner: "team-platform", system: "audit" },
  ],
  questionFiles: [
    {
      id: "q-a4a06bcb15a5",
      question: "Is docs/ a generated playground?",
      repo: "forge-notes",
    },
  ],
  triage: [],
  steps: [
    {
      id: "s1",
      title: "File the gateway request",
      system: "service-desk",
      change: "add-transfer-limit",
    },
    { id: "s2", title: "Rotate the ledger key", system: "service-desk" },
  ],
  needs: [
    {
      change: "add-transfer-limit",
      item: "firewall-rule-request",
      title: "Network firewall rule",
      kind: "request",
      status: "open",
    },
    {
      change: "fix-northwind-timeout",
      item: "northwind-pay",
      title: "Northwind Pay",
      kind: "vendor",
      status: "open",
    },
  ],
  knowledgeToVerify: 3,
};

describe("what needs a person, grouped by change (ADR 0105 addendum)", () => {
  const items = inboxOf(data);

  it("puts each change with something open in a group, blocking first, needs then findings then steps", () => {
    const w = waitingByChange(items, changes, "");
    expect(w.groups.map((g) => g.change)).toEqual([
      "fix-northwind-timeout",
      "add-transfer-limit",
      undefined,
    ]);
    const [fix, add, none] = w.groups;
    expect(fix).toMatchObject({ title: "Fix the Northwind timeout", blocking: 1, count: 2 });
    expect(add!.sections.map((s) => s.kind)).toEqual(["need", "finding", "step"]);
    expect(add!.sections.map((s) => s.items.map((i) => i.title))).toEqual([
      ["Network firewall rule"],
      ["No measure for the outcome"],
      ["File the gateway request"],
    ]);
    // A change with nothing open has no group.
    expect(w.groups.some((g) => g.change === "quiet-change")).toBe(false);
    // What belongs to no change: questions by repo, steps with no change, knowledge to verify.
    expect(none!.sections.map((s) => [s.kind, s.repo])).toEqual([
      ["question", "audit"],
      ["question", "forge-notes"],
      ["step", undefined],
      ["knowledge", undefined],
    ]);
    expect(none!.sections.at(-1)!.items[0]).toMatchObject({
      title: T.knowledgeToVerify(3),
      href: "#/knowledge",
    });
    expect(w.total).toBe(9);
    expect(w.shown).toBe(9);
  });

  it("filters on title, id, change and repo, case aside", () => {
    const by = (text: string) =>
      waitingByChange(items, changes, text).groups.map((g) => [
        g.change,
        g.sections.flatMap((s) => s.items.map((i) => i.title)),
      ]);
    expect(by("FIREWALL")).toEqual([["add-transfer-limit", ["Network firewall rule"]]]);
    expect(by("northwind-pay")).toEqual([["fix-northwind-timeout", ["Northwind Pay"]]]);
    // A change's id or title keeps every item of it.
    expect(by("fix-northwind")).toEqual([
      ["fix-northwind-timeout", ["Northwind Pay", "No retry on the Northwind call"]],
    ]);
    expect(by("forge-notes")).toEqual([[undefined, ["Is docs/ a generated playground?"]]]);
    expect(waitingByChange(items, changes, "nothing like it")).toMatchObject({
      groups: [],
      shown: 0,
      total: 9,
    });
  });

  it("renders each group with its title, id and count, and says when nothing matches", () => {
    const out = html(
      <WaitingList items={items} changes={changes} text="" onText={() => {}} state="ready" />,
    );
    expect(out).toContain(`placeholder="${F.placeholder}"`);
    expect(out).toContain('href="#/changes/fix-northwind-timeout"');
    expect(out).toContain(">fix-northwind-timeout<");
    expect(out).toContain(T.groupCount(2));
    expect(out).toContain(T.blocked);
    expect(out).toContain(T.noChangeGroup);
    expect(out).toContain(esc(T.sectionQuestions("forge-notes")));
    expect(out).toContain('href="#/questions/q-a4a06bcb15a5"');
    expect(out.indexOf("fix-northwind-timeout")).toBeLessThan(out.indexOf("add-transfer-limit"));

    const none = html(
      <WaitingList
        items={items}
        changes={changes}
        text="nothing like it"
        onText={() => {}}
        state="ready"
      />,
    );
    expect(none).toContain(esc(F.nothingMatches(F.words("nothing like it"))));
    expect(none).toContain(F.clear);
    expect(none).toContain(F.shown(0, 9));
  });

  it("has loading, error and empty states", () => {
    const at = (state: "loading" | "error" | "ready", list = items) =>
      html(<WaitingList items={list} changes={changes} text="" onText={() => {}} state={state} />);
    expect(at("loading")).toContain('role="status"');
    expect(at("error")).toContain('role="alert"');
    expect(at("ready", [])).toContain(esc(T.nothingNeedsAPerson));
  });
});

const question = (id: string, repo: string, words: string): QuestionView => ({
  schemaVersion: 1,
  id,
  askedBy: {
    step: "scan-survey",
    command: `atticus scan survey ${repo}`,
    at: "2026-10-21T12:00:00Z",
  },
  repo,
  question: words,
  options: [{ label: "Yes", means: "it is", changes: "the scan reads it" }],
  evidence: ["docs/playground.js:1"],
  scope: { level: "repo", id: repo },
  state: "open",
  rerun: `atticus scan survey ${repo} --force`,
});

describe("the Questions filter and repo picker", () => {
  const qs = [
    question("q-a4a06bcb15a5", "forge-notes", "Is docs/ a generated playground?"),
    question("q-0000000000b1", "forge-ledger", "Does the ledger retry a failed post?"),
  ];

  it("matches question words, id and repo, and picks a repo", () => {
    expect(questionRepos(qs)).toEqual(["forge-ledger", "forge-notes"]);
    expect(shownQuestions(qs, { text: "PLAYGROUND", repo: "" }).map((q) => q.id)).toEqual([
      "q-a4a06bcb15a5",
    ]);
    expect(shownQuestions(qs, { text: "q-0000000000b1", repo: "" }).map((q) => q.repo)).toEqual([
      "forge-ledger",
    ]);
    expect(shownQuestions(qs, { text: "forge", repo: "forge-ledger" })).toHaveLength(1);
    expect(shownQuestions(qs, { text: "", repo: "" })).toHaveLength(2);
  });

  it("says what was filtered, with the repo, and offers to clear it", () => {
    const out = html(
      <QuestionList
        of={{ state: "ready", data: { questions: qs, problems: [] } }}
        text="playground"
        repo="forge-ledger"
        onClear={() => {}}
      />,
    );
    expect(out).toContain(
      esc(F.nothingMatches(`${F.words("playground")} ${F.inRepo("forge-ledger")}`)),
    );
    expect(out).toContain(F.clear);
    expect(out).toContain(F.shown(0, 2));
    const one = html(
      <QuestionList
        of={{ state: "ready", data: { questions: qs, problems: [] } }}
        text="ledger"
        repo=""
      />,
    );
    expect(one).toContain('href="#/questions/q-0000000000b1"');
    expect(one).not.toContain('href="#/questions/q-a4a06bcb15a5"');
  });
});

describe("the Manual steps filter", () => {
  const step = {
    id: "gateway-request",
    title: "File the gateway request",
    system: "service-desk",
    change: "add-transfer-limit",
  };
  it("matches a step's title, id, change and system", () => {
    expect(matchStep(step, "GATEWAY")).toBe(true);
    expect(matchStep(step, "transfer-limit")).toBe(true);
    expect(matchStep(step, "service-desk")).toBe(true);
    expect(matchStep(step, "ledger")).toBe(false);
    expect(matchStep({ ...step, change: undefined }, "")).toBe(true);
  });
});

describe("the Knowledge items filter", () => {
  it("says what was filtered, with the kind, and offers to clear both", () => {
    const out = html(
      <ItemList of={{ state: "ready", data: { items: [], problems: [] } }} text="ledger" kind="" />,
    );
    // No items at all is the empty state, not a filter that matched nothing.
    expect(out).not.toContain(F.clear);
    const item = {
      id: "kafka-topic-request",
      kind: "request",
      recordKind: "ProcessDefinition",
      title: "Kafka topic",
      record: {},
      fields: {},
      conflict: false,
    } as const;
    const none = html(
      <ItemList
        of={{ state: "ready", data: { items: [item], problems: [] } }}
        text="ledger"
        kind="vendor"
        onClear={() => {}}
      />,
    );
    expect(none).toContain(esc(F.nothingMatches(`${F.words("ledger")} ${F.among("Vendor")}`)));
    expect(none).toContain(F.clear);
  });
});
