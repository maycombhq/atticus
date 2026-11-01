import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import {
  aboutWords,
  answerBody,
  AnsweredView,
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
