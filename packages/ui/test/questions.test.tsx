import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import { RunStep } from "../src/app/runstep.js";
import {
  aboutWords,
  ANOTHER_REPO,
  answerBody,
  TargetPickerView,
  type AnswerForm,
  AnsweredView,
  isChangeQuestion,
  ExcerptView,
  QuestionDetail,
  QuestionList,
  questionRoute,
  questionsUrl,
  type QuestionView,
} from "../src/screens/Questions.js";

const C = COPY.questions;

const question: QuestionView = {
  schemaVersion: 1,
  id: "q-a4a06bcb15a5",
  askedBy: {
    step: "scan-survey",
    command: "atticus scan survey forge-notes",
    at: "2026-10-21T12:00:00.000Z",
  },
  repo: "forge-notes",
  question: "Is docs/ a generated playground or part of the product?",
  options: [
    { label: "Generated", means: "nobody edits it", changes: "the scan leaves docs/ out" },
    { label: "Product", means: "it ships", changes: "the scan reads docs/" },
  ],
  evidence: ["docs/playground.js:1"],
  scope: { level: "repo", id: "forge-notes" },
  state: "open",
  rerun: "atticus scan survey forge-notes --force",
};

const html = (el: ReactElement) => renderToStaticMarkup(el);

describe("the Questions page (ADR 0078)", () => {
  it("reads the question id from the route", () => {
    expect(questionRoute("#/questions")).toBeUndefined();
    expect(questionRoute("#/questions/q-a4a06bcb15a5")).toBe("q-a4a06bcb15a5");
    expect(questionRoute("#/questions/not an id")).toBeUndefined();
  });

  it("has loading, error and empty states for the list", () => {
    expect(html(<QuestionList of={{ state: "loading" }} />)).toContain('aria-busy="true"');
    expect(html(<QuestionList of={{ state: "error", error: "boom" }} />)).toContain('role="alert"');
    expect(
      html(<QuestionList of={{ state: "ready", data: { questions: [], problems: [] } }} />),
    ).toContain(C.empty);
  });

  it("lists each question as a link to it, and says which files it can't read", () => {
    const out = html(
      <QuestionList
        of={{
          state: "ready",
          data: {
            questions: [question],
            problems: [{ file: "questions/q-000000000000.yaml", message: "state: bad" }],
          },
        }}
        current="q-a4a06bcb15a5"
      />,
    );
    expect(out).toContain('href="#/questions/q-a4a06bcb15a5"');
    expect(out).toContain('aria-current="true"');
    expect(out).toContain(question.question);
    expect(out).toContain("questions/q-000000000000.yaml");
  });

  it("shows a question's options, evidence and scope as a form a keyboard can use", () => {
    const out = html(<QuestionDetail question={question} onAnswered={() => {}} />);
    expect(out).toContain("<fieldset");
    expect(out).toContain("<legend");
    expect(out).toContain('type="radio"');
    expect(out).toContain("Generated");
    expect(out).toContain("the scan leaves docs/ out");
    expect(out).toContain("docs/playground.js:1");
    expect(out).toContain(C.ownWords);
    expect(out).toContain(C.scopeRepo("forge-notes"));
    expect(out).toContain('type="submit"');
    // Every input has a label.
    const inputs = out.match(/<input[^>]*id="([^"]+)"/g) ?? [];
    for (const i of inputs) {
      const id = /id="([^"]+)"/.exec(i)![1];
      expect(out, id).toContain(`for="${id}"`);
    }
  });

  it("builds the answer request from the form, or says what is missing", () => {
    expect(answerBody({ pick: 2, text: "", scope: "repo", repoType: "" })).toEqual({
      body: { option: 2, scope: "repo" },
    });
    expect(
      answerBody({ pick: "words", text: "  Only docs/api ", scope: "repo", repoType: "" }),
    ).toEqual({
      body: { text: "Only docs/api", scope: "repo" },
    });
    expect(answerBody({ pick: undefined, text: "", scope: "repo", repoType: "" })).toEqual({
      error: C.pickOne,
    });
    expect(answerBody({ pick: "words", text: " ", scope: "repo", repoType: "" })).toEqual({
      error: C.needWords,
    });
    expect(answerBody({ pick: 1, text: "", scope: "repo-type", repoType: "" })).toEqual({
      error: C.needType,
    });
    expect(
      answerBody({ pick: 1, text: "", scope: "repo-type", repoType: "forge-service" }),
    ).toEqual({ body: { option: 1, scope: "repo-type", repoType: "forge-service" } });
  });

  it("after answering, shows the command to run next with a copy button", () => {
    const out = html(
      <AnsweredView
        result={{
          question: {
            ...question,
            state: "answered",
            answer: {
              option: 1,
              by: "priya.nair",
              at: "2026-10-21T12:00:00.000Z",
              scope: { level: "repo", id: "forge-notes" },
            },
          },
          rerun: "atticus scan survey forge-notes --force",
        }}
      />,
    );
    expect(out).toContain('role="status"');
    expect(out).toContain(C.next);
    expect(out).toContain("atticus scan survey forge-notes --force");
    expect(out).toContain("Copy");
  });
});

describe("a change's empty list (ninth UX walk)", () => {
  it("says the change has no question, not that a scan adds one", () => {
    const of = {
      state: "ready" as const,
      data: { questions: [], problems: [] } as never,
      reload: () => {},
    };
    const out = html(<QuestionList of={of as never} change="lock-card" />);
    expect(out).toContain(C.emptyChange("lock-card"));
    expect(out).not.toContain("A scan step adds one");
  });
});

describe("after a change's question is answered (sixth UX walk)", () => {
  const change = "show-account-status";
  const asked: QuestionView = {
    ...question,
    askedBy: {
      step: "context-gap",
      command: `atticus change feature ${change}`,
      at: question.askedBy.at,
    },
    repo: change,
    scope: { level: "repo", id: change },
  };
  it("offers the stage's step from the app first, then the command", () => {
    const tree = AnsweredView({
      result: { question: asked, rerun: `atticus change feature ${change}` },
    });
    const found: string[] = [];
    const walk = (t: unknown) => {
      if (Array.isArray(t)) t.forEach(walk);
      else if (t && typeof t === "object" && "props" in t) {
        const e = t as { type: unknown; props: { command?: string; children?: unknown } };
        if (e.type === RunStep) found.push(e.props.command!);
        walk(e.props.children);
      }
    };
    walk(tree);
    expect(found).toEqual([`atticus change feature ${change}`]);
    expect(JSON.stringify(tree)).toContain(C.orCommandLine);
    expect(JSON.stringify(tree)).not.toContain("On the command line:");
  });
  it("calls the change's scope the change's, a repo's the repo's", () => {
    expect(isChangeQuestion(asked)).toBe(true);
    expect(isChangeQuestion(question)).toBe(false);
  });
});

describe("evidence beside a question (WP7.2)", () => {
  it("shows the lines around the cited line, the cited one marked", () => {
    const out = renderToStaticMarkup(
      <ExcerptView
        e={{
          ref: "src/NoteController.java:6",
          line: 6,
          start: 5,
          lines: ["public class NoteController {", "  @GetMapping", "  public List<Note> list() {"],
          found: true,
        }}
      />,
    );
    expect(out).toContain("src/NoteController.java:6");
    expect(out).toContain("<mark>  @GetMapping</mark>");
    expect(out).toContain('aria-current="true"');
    expect(out).toContain("   5  ");
  });

  it("says when a cited line can't be shown", () => {
    const out = renderToStaticMarkup(
      <ExcerptView e={{ ref: "src/Gone.java:3", line: 3, start: 3, lines: [], found: false }} />,
    );
    expect(out).toContain(COPY.questions.notShown.replace(/'/g, "&#x27;"));
    expect(out).not.toContain("<pre");
  });
});

describe("the Questions page asks in order and routes to the owner (ADR 0140)", () => {
  it("asks for everyone's or the person's teams' questions", () => {
    expect(questionsUrl("open", "all")).toBe("/api/questions?state=open");
    expect(questionsUrl("open", "mine")).toBe("/api/questions?state=open&mine=true");
    expect(questionsUrl("all", "mine")).toBe("/api/questions?mine=true");
    expect(questionsUrl("all", "all")).toBe("/api/questions");
  });

  it("says under each question who owns it, what change rests on it and the calls it joins", () => {
    const out = html(
      <QuestionList
        of={{
          state: "ready",
          data: {
            questions: [question],
            problems: [],
            about: {
              [question.id]: {
                restsOn: ["add-transfer-limit"],
                joins: 3,
                owner: { team: "team-ledger", name: "Ledger team" },
              },
            },
          },
        }}
      />,
    );
    expect(out).toContain(C.restsOn(["add-transfer-limit"]));
    expect(out).toContain(C.owner("team-ledger", "Ledger team"));
    expect(out).toContain(C.joins(3));
    expect(
      aboutWords({ restsOn: [], joins: 0, owner: { none: "no repos.manifest.yaml lists x" } }),
    ).toEqual([C.noOwner("no repos.manifest.yaml lists x")]);
  });

  it("says when the person is on no team, and when their teams have nothing waiting", () => {
    const none = html(
      <QuestionList
        mine
        of={{
          state: "ready",
          data: { questions: [], problems: [], me: { handle: "dee", teams: [] } },
        }}
      />,
    );
    expect(none).toContain(C.mineNone("dee").replace(/'/g, "&#x27;"));
    const empty = html(
      <QuestionList
        mine
        of={{
          state: "ready",
          data: {
            questions: [],
            problems: [],
            me: { handle: "sam", teams: [{ id: "team-ledger", name: "Ledger team" }] },
          },
        }}
      />,
    );
    expect(empty).toContain(C.mineTeams("Ledger team"));
    expect(empty).toContain(C.emptyMine);
  });

  it("pre-fills the rule several open target questions share, and says so (ADR 0168)", () => {
    const targets: QuestionView = {
      ...question,
      askedBy: { ...question.askedBy, step: "facts-targets" },
    };
    const rule = { match: "/accounts/**", ids: [targets.id, "q-0123456789ab"], calls: 4 };
    const out = html(<QuestionDetail question={targets} onAnswered={() => {}} rule={rule} />);
    expect(out).toContain('value="/accounts/**"');
    expect(out).toContain(C.rule.offer(2, 4, "/accounts/**"));
    expect(aboutWords({ restsOn: [], joins: 0, owner: { none: "x" }, rule })).toContain(
      C.rule.offerListed(2, "/accounts/**"),
    );
  });

  it("a target or hosts question takes a rule in the form, labelled, and sends it (ADR 0153)", () => {
    const hosts: QuestionView = {
      ...question,
      askedBy: { ...question.askedBy, step: "scan-hosts" },
      question: "Which repo answers on limits.payments.forge.internal?",
    };
    const out = html(<QuestionDetail question={hosts} onAnswered={() => {}} />);
    expect(out).toContain(C.rule.label);
    expect(out).toContain(`for="q-${hosts.id}-match"`);
    expect(out).toContain(`aria-describedby="q-${hosts.id}-match-d"`);
    expect(html(<QuestionDetail question={question} onAnswered={() => {}} />)).not.toContain(
      C.rule.label,
    );
    expect(
      answerBody({
        pick: 1,
        text: "",
        scope: "repo",
        repoType: "",
        match: " *.payments.forge.internal ",
      }),
    ).toEqual({ body: { option: 1, scope: "repo", match: "*.payments.forge.internal" } });
    expect(answerBody({ pick: 1, text: "", scope: "repo", repoType: "", match: " " })).toEqual({
      body: { option: 1, scope: "repo" },
    });
  });

  it("shows an answer's rule, and that it was the assistant's proposal a person confirmed (ADR 0153)", () => {
    const answered: QuestionView = {
      ...question,
      schemaVersion: 3,
      askedBy: { ...question.askedBy, step: "facts-targets" },
      state: "answered",
      answer: {
        option: 1,
        by: "priya.nair",
        at: "2026-11-01T12:00:00.000Z",
        scope: { level: "repo", id: "forge-notes" },
        match: "/forge/limits/**",
        proposal: {
          by: "claude-code",
          at: "2026-10-31T12:00:00.000Z",
          cites: [{ file: "docs/playground.js", line: 1, quote: "Generated by the docs build" }],
        },
      },
    };
    const out = html(<QuestionDetail question={answered} onAnswered={() => {}} />);
    expect(out).toContain(C.rule.answered("/forge/limits/**"));
    expect(out).toContain(C.fromProposal("claude-code", "2026-10-31").replace(/'/g, "&#x27;"));
    expect(out).toContain("docs/playground.js:1");
  });

  it("names a change's people as the owner of its questions, and says so under --mine (ADR 0153)", () => {
    expect(
      aboutWords({ restsOn: [], joins: 0, owner: { change: "add-pins", people: ["ari", "sam"] } }),
    ).toEqual([C.changeOwner("add-pins", ["ari", "sam"])]);
    const out = html(
      <QuestionList
        mine
        of={{
          state: "ready",
          data: { questions: [question], problems: [], me: { handle: "ari", teams: [] } },
        }}
      />,
    );
    expect(out).toContain(C.mineChanges("ari"));
  });
});

describe("Another repo… on a targets question (ADR 0162, F8)", () => {
  const target: QuestionView = {
    ...question,
    schemaVersion: 4,
    askedBy: { ...question.askedBy, step: "facts-targets" },
    repo: "forge-payments",
    question: "Which repo or system answers GET /limits/{id}, which payments-api calls?",
    options: [
      { label: "forge-cards", means: "forge-cards, not read yet, answers it", changes: "joins it" },
      { label: ANOTHER_REPO, means: "the picker", changes: "name one" },
    ],
  };
  const form = (over: Partial<AnswerForm> = {}): AnswerForm => ({
    pick: 2,
    text: "",
    scope: "repo",
    repoType: "",
    another: true,
    ...over,
  });
  const picks = {
    picks: [
      { id: "forge-cards", kind: "repo" as const, name: "forge-cards (cards-api)", read: false },
      { id: "northwind-pay", kind: "system" as const, name: "Northwind Pay", boundary: "vendor" },
      {
        id: "team-ledger-ops",
        kind: "team" as const,
        name: "Ledger Ops",
        adds: {
          id: "team-ledger-ops-system",
          name: "Ledger Ops's system",
          boundary: "internal" as const,
          owner: "team-ledger-ops",
        },
      },
    ],
  };
  const view = (of: Parameters<typeof TargetPickerView>[0]["of"], f = form()) =>
    html(<TargetPickerView id={target.id} form={f} set={() => {}} of={of} />);

  it("has loading, error and empty states", () => {
    expect(view({ state: "loading" })).toContain('aria-busy="true"');
    expect(view({ state: "error", error: "boom" })).toContain('role="alert"');
    expect(view({ state: "ready", data: { picks: [] } })).toContain(C.another.empty);
  });

  it("lists the repos (read or not), the systems and the teams, each labelled", () => {
    const out = view({ state: "ready", data: picks });
    expect(out).toContain(`<label for="q-${target.id}-target-pick"`);
    expect(out).toContain(`forge-cards (cards-api) (${C.another.notRead})`);
    expect(out).toContain("Northwind Pay (vendor)");
    expect(out).toContain(`Ledger Ops (${C.another.noSystem})`);
    expect(out).not.toContain('type="checkbox"');
  });

  it("offers to add a team's system to the profile, and sends it only when ticked", () => {
    const f = form({ target: "team-ledger-ops", needsSystem: "internal" });
    const out = view({ state: "ready", data: picks }, f);
    expect(out).toContain('type="checkbox"');
    expect(out).toContain(
      C.another.addTeam("team-ledger-ops", "Ledger Ops&#x27;s system").replace(/'/g, "&#x27;"),
    );
    expect(answerBody(f)).toEqual({ error: C.another.needAdd });
    expect(answerBody({ ...f, addSystem: "internal" })).toEqual({
      body: { target: "team-ledger-ops", addSystem: "internal", scope: "repo" },
    });
    expect(answerBody(form())).toEqual({ error: C.another.pickOne });
    expect(answerBody(form({ target: "forge-cards" }))).toEqual({
      body: { target: "forge-cards", scope: "repo" },
    });
  });

  it("says when an answer was asked again, and why", () => {
    const out = html(
      <QuestionDetail
        question={{
          ...target,
          reopened: {
            at: "2026-11-01T12:00:00.000Z",
            why: "forge-cards is read now, and no route of it serves GET /limits/{id}",
            answer: {
              option: 1,
              by: "pat",
              at: "2026-10-30T12:00:00.000Z",
              scope: { level: "repo", id: "forge-payments" },
            },
          },
        }}
        onAnswered={() => {}}
      />,
    );
    expect(out).toContain(
      C.reopened(
        "forge-cards is read now, and no route of it serves GET /limits/{id}",
        "forge-cards",
        "2026-11-01",
      ),
    );
  });
});
