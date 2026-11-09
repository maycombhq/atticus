import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * Seventh UX walk (answers and access): Apply for answers after the page is left, words instead
 * of commands on a question, a status chip that says a file isn't written, Initiatives' words and
 * list, the pages' sections, an error that says what the server answered, focus that is seen and
 * kept, and count tiles that are buttons only when they filter.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
let applyFirst: string[] = [];
let initiatives: unknown[] = [];
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  api: async () => ({ initiative: "branch-self-service", lines: [] }),
  useApi: (path: string) =>
    path.startsWith("/api/initiatives")
      ? { state: "ready", data: initiatives, reload: () => {} }
      : !path.startsWith("/api/propose")
        ? { state: "loading", reload: () => {} }
        : {
            state: "ready",
            data: {
              scope: "work",
              files: [{ path: "questions/q-b4c786e258b1.yaml", status: "M" }],
              branch: "propose/work/2026-11-08-pat",
              title: "Changes made in the Atticus app",
              applyFirst,
            },
            reload: () => {},
          },
}));
const { COPY } = await import("../src/copy.js");
const Q = await import("../src/screens/Questions.js");
const { ApplyAndPropose } = await import("../src/app/propose.js");
const { artifactStatusWord } = await import("../src/app/artifact-status.js");
const { screenOf, tabsOf } = await import("../src/app/screens.js");
const { problemOf } = await import("../src/api/client.js");
const { HowStepsRunLine, WaitingList } = await import("../src/screens/CommandCenter.js");
const { NewInitiative } = await import("../src/screens/know/InitiativeForms.js");
const { InitiativeChanges, Initiatives, initiativeStatusWord } =
  await import("../src/screens/know/Design.js");
const C = COPY.questions;
const D = COPY.design;

const mapQuestion = {
  schemaVersion: 4,
  id: "q-b4c786e258b1",
  askedBy: {
    step: "facts-targets",
    command: "atticus verify forge-proxy-core-v1 --write",
    at: "2026-11-08T15:43:28.661Z",
  },
  repo: "forge-proxy-core-v1",
  question: "Which repo serves the routes under /accounts/**?",
  options: [
    {
      label: "ledger-core",
      means: "ledger-core, built in forge-ledger-core",
      changes:
        "The 3 calls join ledger-core when the facts are next written (atticus verify forge-proxy-core-v1 --write)",
    },
    {
      label: "Another repo…",
      means: "A repo, system or team not listed here",
      changes:
        "Nothing until you name one: atticus questions answer <id> --target <repo, system or team id> lists them and takes the one you name (the app's Questions page lists them too); naming a vendor adds that system",
    },
  ],
  evidence: [],
  scope: { level: "repo", id: "forge-proxy-core-v1" },
  state: "answered",
  rerun: "atticus verify forge-proxy-core-v1 --write",
  answer: {
    option: 1,
    by: "pat",
    at: "2026-11-08T15:45:00Z",
    scope: { level: "repo", id: "forge-proxy-core-v1" },
  },
} as const;

describe("answers offered for Apply after the page is left", () => {
  it("an answered map question shows Apply while its repo's answers aren't applied", () => {
    const tree = Q.QuestionDetail({ question: mapQuestion as never, onAnswered: () => {} });
    const pending = all(tree).find((e) => e.type === Q.ApplyPending);
    expect(pending?.props.repo).toBe("forge-proxy-core-v1");
    applyFirst = ["forge-proxy-core-v1"];
    const m = mount(Q.ApplyPending as never, { repo: "forge-proxy-core-v1" } as never);
    expect(all(m.tree).find((e) => e.type === ApplyAndPropose)?.props.repo).toBe(
      "forge-proxy-core-v1",
    );
    applyFirst = [];
    const n = mount(Q.ApplyPending as never, { repo: "forge-proxy-core-v1" } as never);
    expect(all(n.tree).some((e) => e.type === ApplyAndPropose)).toBe(false);
  });

  it("Home's line names answers as well as corrections", () => {
    expect(COPY.propose.applyFirst).toMatch(/answers/);
  });
});

describe("a question in words, not commands", () => {
  it("says when it was asked in words", () => {
    const w = Q.askedByWords(mapQuestion.askedBy, "2026-11-08");
    expect(w).toBe(C.askedWhen.verify("forge-proxy-core-v1", "2026-11-08"));
    expect(w).not.toMatch(/atticus|--write/);
    expect(
      Q.askedByWords(
        { step: "context-gap", command: "atticus change feature add-a-limit" },
        "2026-11-08",
      ),
    ).toBe(C.askedWhen.stage("feature", "add-a-limit", "2026-11-08"));
    expect(
      Q.askedByWords({ step: "scan-survey", command: "atticus scan survey forge-notes" }, "d"),
    ).not.toMatch(/atticus scan/);
  });

  it("says what an option changes without a command", () => {
    const out = renderToStaticMarkup(
      <Q.QuestionDetail question={mapQuestion as never} onAnswered={() => {}} />,
    );
    expect(out).not.toContain("atticus verify");
    expect(out).not.toContain("atticus questions answer");
    expect(out).not.toContain("--target");
    expect(Q.changesInWords(mapQuestion.options[0].changes)).toBe(
      `The 3 calls join ledger-core ${C.whenApplied("forge-proxy-core-v1")}`,
    );
  });
});

describe("focus after saving an answer (WCAG 2.4.3)", () => {
  it("moves focus to the saved note", () => {
    const tree = Q.AnsweredView({
      result: { question: mapQuestion as never, rerun: mapQuestion.rerun },
    });
    const status = all(tree).find((e) => e.props.role === "status")!;
    expect(status.props.tabIndex).toBe(-1);
    let focused = 0;
    (status.props.ref as (el: { focus: () => void } | null) => void)({
      focus: () => void focused++,
    });
    expect(focused).toBe(1);
  });
});

describe("the header's Ask field shows focus (WCAG 2.4.7)", () => {
  // Ninth UX walk: the field draws its own ring (the walk read no outline on the focused field).
  it("has a focus rule on the field and on the form that holds it", () => {
    const css = readFileSync(
      fileURLToPath(new URL("../src/styles/hud.css", import.meta.url)),
      "utf8",
    );
    expect(css).toMatch(/\.ask-form input:focus-visible\s*\{[^}]*outline:\s*2px solid/);
    expect(css).toMatch(/\.ask-form:focus-within\s*\{[^}]*border-color/);
  });
});

describe("the count tiles", () => {
  it("are buttons only when they filter", () => {
    const out = renderToStaticMarkup(
      <Q.QuestionCounts
        counts={{ open: 0, answered: 1, retired: 5, total: 6, repos: 2 }}
        filter="open"
        onFilter={() => {}}
      />,
    );
    expect(out.match(/<button/g)).toHaveLength(2);
    expect(out).not.toContain("disabled");
  });
});

describe("a file's status", () => {
  it("says a missing file isn't written yet", () => {
    const S = COPY.artifactStatus;
    expect(artifactStatusWord({ status: "ready", written: false })).toBe(S.notWritten);
    expect(artifactStatusWord({ status: "blocked", written: false })).toBe(S.notWritten);
    expect(artifactStatusWord({ status: "done", written: true })).toBe(S.written);
    expect(artifactStatusWord({ status: "ready", written: true })).toBe(S.needsWork);
    expect(artifactStatusWord({ status: "ready" })).not.toBe("READY");
  });
});

describe("pages in the right section", () => {
  it("Initiatives and Manual steps under Home, Governance under Set up", () => {
    expect(screenOf("#/initiatives").section).toBe("Home");
    expect(screenOf("#/todo").section).toBe("Home");
    expect(screenOf("#/governance").section).toBe("SetUp");
    // ADR 0188: the manual steps are a tab of Home by default.
    expect(tabsOf("Home").map((t) => t.id)).toEqual(["home", "todo"]);
  });
});

describe("the error state says what the server answered", () => {
  it("names the status and the server's words when the problem has no detail", () => {
    const p = problemOf({ error: "injected failure" }, 500, "Internal Server Error");
    expect(p.detail).toContain("500");
    expect(p.detail).toContain("injected failure");
    expect(problemOf(undefined, 502, "").detail).toContain("502");
    expect(problemOf({ title: "Bad", status: 400, detail: "Name it." }, 400, "").detail).toBe(
      "Name it.",
    );
  });

  it("names runtime.yaml only when the problem does", () => {
    const why = (s: string) => renderToStaticMarkup(<HowStepsRunLine failed why={s} />);
    expect(why("The server answered 500: injected failure")).not.toContain("runtime.yaml");
    expect(why("The server answered 500: injected failure")).toContain("injected failure");
    expect(why("org-pack/runtime.yaml: adapters is required")).toContain("runtime.yaml");
    const list = renderToStaticMarkup(
      <WaitingList
        items={[]}
        changes={[]}
        text=""
        onText={() => {}}
        state="error"
        error="The server answered 500: injected failure"
      />,
    );
    expect(list).toContain("injected failure");
    expect(list).not.toContain("atticus ui");
  });
});

describe("Initiatives", () => {
  it("says a status in words", () => {
    expect(initiativeStatusWord("not-planned")).toBe(D.initiativeStates["not-planned"]);
    expect(initiativeStatusWord("not-planned")).not.toMatch(/-/);
  });

  it("closes the form after Start, keeping the note and Propose", async () => {
    const m = mount(NewInitiative as never, { open: true } as never);
    const title = all(m.tree).find((e) => e.type === "input")!;
    (title.props.onChange as (e: unknown) => void)({ target: { value: "Branch self-service" } });
    m.render();
    const form = all(m.tree).find((e) => e.type === "form")!;
    (form.props.onSubmit as (e: unknown) => void)({ preventDefault: () => {} });
    await new Promise((r) => setTimeout(r, 0));
    m.render();
    expect(all(m.tree).some((e) => e.type === "form")).toBe(false);
    expect(JSON.stringify(m.tree)).toContain(D.startedInitiative("branch-self-service"));
    expect(text(m.tree)).toContain(D.newInitiative);
  });

  it("lists the changes the plan wrote, and says no plan in words", () => {
    initiatives = [
      {
        initiative: "branch-self-service",
        title: "Branch self-service",
        journey: "new-feature",
        status: "on-track",
        today: "2026-11-08",
        items: [],
        criticalPath: [],
        commitments: [],
        changes: [{ id: "branch-self-service-branch" }, { id: "add-a-limit", state: "define" }],
        notes: [],
      },
      {
        initiative: "teller-refresh",
        title: "Teller refresh",
        journey: "new-feature",
        status: "not-planned",
        today: "2026-11-08",
        items: [],
        criticalPath: [],
        commitments: [],
        changes: [],
        notes: ["Initiative teller-refresh has no plan yet: run initiative plan."],
      },
    ];
    const m = mount(Initiatives as never, { hash: "#/initiatives" } as never);
    const panel = all(m.tree).find((e) => e.props.title === D.changesToStart)!;
    const list = all(panel.props.children).find((e) => e.type === InitiativeChanges)!;
    const out = renderToStaticMarkup(<InitiativeChanges changes={list.props.changes as never} />);
    expect(out).toContain("branch-self-service-branch");
    expect(out).toContain(D.notStartedYet);
    expect(out).toContain('href="#/changes/add-a-limit"');
    expect(renderToStaticMarkup(<InitiativeChanges changes={[]} />)).toContain(D.noChangesYet);
    const n = mount(Initiatives as never, { hash: "#/initiatives?id=teller-refresh" } as never);
    expect(text(n.tree)).not.toContain("run initiative plan");
    expect(text(n.tree)).toContain(D.noPlanYet);
  });
});
