import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "@maycombhq/core";

/**
 * ADR 0181 part 1, the screens: wherever an AI decision shows it carries "Detected by AI", with
 * its run linked (and Correct where it is a standing decision): Questions, the canvas's Why is
 * this linked? and corrections, Connect, Match with Copilot, Contracts, a change's impact and its
 * knowledge, Home's pause and Map › Trust's AI precision. Counts split three ways where shown.
 */

vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  useApi: (path?: string) =>
    path?.startsWith("/api/catalog/Interface")
      ? {
          state: "ready",
          data: {
            items: [
              {
                id: "if-ai",
                kind: "Interface",
                from: "forge-billing",
                to: "forge-payments",
                confidence: "inferred",
                flags: ["joined-by-ai"],
                evidence: [{ source: "ai", repo: "forge-billing", run: "run-match-0007" }],
              },
              { id: "if-code", kind: "Interface", from: "a", to: "b", confidence: "verified" },
            ],
            total: 2,
          },
          reload: () => undefined,
        }
      : { state: "loading", reload: () => undefined },
  useLiveEvents: () => undefined,
  useReloadOnFiles: () => undefined,
}));

const { COPY } = await import("../src/copy.js");
const { DecisionsContext, staticDecisions } = await import("../src/app/decisions.js");
const { QuestionDetail, QuestionList, QuestionsAiCounts } =
  await import("../src/screens/Questions.js");
const { ImpactView } = await import("../src/screens/work/Impact.js");
const { CorrectionsList } = await import("../src/screens/architecture/Declare.js");
const { JoinView } = await import("../src/screens/architecture/WhyLinked.js");
const { AiPairedBetween } = await import("../src/screens/architecture/Connect.js");
const { MatchDecided } = await import("../src/screens/architecture/Match.js");
const { ContractList, ContractsAiCounts } = await import("../src/screens/know/Design.js");
const { TrustRow, TrustPage } = await import("../src/screens/map/Trust.js");
const { HomeDecidePaused } = await import("../src/screens/CommandCenter.js");
const { ConflictList } = await import("../src/screens/knowledge/shared.js");

const D = COPY.decisions;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const tally = (right: number, wrong: number, precision: number | null) => ({
  drawn: right + wrong,
  right,
  wrong,
  unsure: 0,
  open: 0,
  gone: 0,
  precision,
  low: precision === null ? null : 0.6,
  high: precision === null ? null : 0.99,
});

const LINK: Api.AiDecisionItemT = {
  kind: "link",
  item: "link:forge-billing:call.post.charges-capture",
  repo: "forge-billing",
  what: "forge-billing POST captureChargePath → forge-payments POST /charges/{id}/capture",
  decided: "forge-payments.post.charges-capture",
  call: {
    fact: "call.post.charges-capture",
    file: "src/ChargeClient.java",
    line: 41,
    value: "captureChargePath",
  },
  to: { repo: "forge-payments", method: "POST", path: "/charges/{id}/capture" },
  runtime: "copilot-acp",
  run: "run-match-0007",
  at: "2026-11-08T10:15:00Z",
  cites: [],
};
const ANSWER: Api.AiDecisionItemT = {
  kind: "question",
  item: "q-0123456789ab",
  repo: "forge-ledger",
  what: "Where does NOTIFY_URL go?",
  decided: "forge-notify",
  question: { text: "Where does NOTIFY_URL go?", option: 1, options: ["forge-notify", "Other"] },
  runtime: "copilot-acp",
  run: "run-propose-0003",
  at: "2026-11-08T10:20:00Z",
  cites: [],
};
const VIEW: Api.DecisionsViewT = {
  decide: {
    configured: { links: "auto", questions: "auto", minPrecision: 0.95 },
    now: { links: "auto", questions: "auto" },
    precision: tally(19, 1, 0.95),
  },
  links: { counts: { fromCode: 40, byPerson: 3, byAi: 1 }, items: [LINK] },
  questions: { counts: { fromCode: 5, byPerson: 2, byAi: 1, open: 7 }, items: [ANSWER] },
  batches: [],
  problems: [],
};
const html = (el: ReactElement, view: Api.DecisionsViewT = VIEW) =>
  renderToStaticMarkup(
    <DecisionsContext.Provider value={staticDecisions(view)}>{el}</DecisionsContext.Provider>,
  );

const QUESTION = {
  id: "q-0123456789ab",
  repo: "forge-ledger",
  question: "Where does NOTIFY_URL go?",
  state: "answered",
  options: [
    { label: "forge-notify", means: "It calls forge-notify", changes: "the link" },
    { label: "Other", means: "Somewhere else", changes: "nothing" },
  ],
  evidence: [],
  scope: { level: "repo" },
  askedBy: {
    step: "facts-targets",
    command: "atticus verify forge-ledger",
    at: "2026-11-08T09:00:00Z",
  },
  rerun: "atticus verify forge-ledger --write",
  answer: {
    option: 1,
    by: { kind: "ai", runtime: "copilot-acp", run: "run-propose-0003" },
    at: "2026-11-08T10:20:00Z",
    scope: { level: "repo" },
  },
} as never;

describe("Questions: answered by AI", () => {
  it("says Answered by AI with the chip, the run linked and Correct, never as a person", () => {
    const out = html(<QuestionDetail question={QUESTION} onAnswered={() => undefined} />);
    expect(out).toContain(esc(D.answeredByAi("2026-11-08")));
    expect(out).toContain(esc(D.chip));
    expect(out).toContain('href="#/runs?run=run-propose-0003"');
    expect(out).toContain(esc(D.correctOf(ANSWER.what)));
    expect(out).not.toContain("AI, run");
  });

  it("marks an AI answer in the list (the chip only: the row is a link)", () => {
    const out = html(
      <QuestionList
        of={{ state: "ready", data: { questions: [QUESTION], problems: [] } as never }}
        all
      />,
    );
    expect(out).toContain(esc(D.chip));
    expect(out).not.toContain('href="#/runs?run=run-propose-0003"');
  });

  it("splits the questions three ways: from code, by a person, by AI", () => {
    expect(html(<QuestionsAiCounts />)).toContain(esc(D.counts.line(VIEW.questions.counts)));
  });
});

describe("a change's impact", () => {
  const impact: Api.ChangeImpactT = {
    change: "hold-stock",
    flows: 1,
    breaks: 1,
    mayBreak: 0,
    byAi: 1,
    routes: 0,
    rule: "constitution.change-links-known",
    items: [
      {
        kind: "endpoint",
        flow: "forge-payments.capture",
        repo: "forge-payments",
        name: "POST /charges/{id}/capture",
        why: ["it no longer returns chargeId"],
        fields: { gone: ["chargeId"], required: [] },
        owner: { team: "team-payments" },
        callers: [
          {
            component: "forge-billing",
            repo: "forge-billing",
            verdict: "breaks",
            decidedByAi: true,
            interfaces: ["if-ai"],
            flows: [],
            routes: [],
            at: ["forge-billing src/ChargeClient.java:41"],
            owner: { team: "team-billing" },
          },
        ],
        routes: [],
      },
    ],
    owners: [],
    problems: [],
  } as never;

  it("counts the breaks linked only by AI, and marks each such caller", () => {
    const out = html(<ImpactView i={impact} />);
    expect(out).toContain(esc(D.impactByAi(1)));
    expect(out).toContain(esc(D.chip));
    expect(out).toContain(esc(D.impactCaller));
  });
});

describe("the canvas", () => {
  it("marks a correction line the AI wrote, with its run, and says an unlink in words", () => {
    const out = html(
      <CorrectionsList
        of={{
          state: "ready",
          data: {
            items: [
              {
                kind: "link",
                says: "call.post.charges-capture → forge-payments.post.charges-capture",
                by: "atticus",
                ai: { runtime: "copilot-acp", run: "run-match-0007" },
                batch: "b-20261108-101500-a1b2c3",
                file: "facts/forge-billing.corrections.jsonl",
                undo: { repo: "forge-billing", line: "{}" },
              },
              {
                kind: "unlink",
                says: "call.get.receipt reaches none of these",
                by: "Priya Nair",
                file: "facts/forge-billing.corrections.jsonl",
                undo: { repo: "forge-billing", line: "{}" },
              },
            ],
          },
        }}
      />,
    );
    expect(out).toContain(esc(D.chip));
    expect(out).toContain('href="#/runs?run=run-match-0007"');
    expect(out).toContain(esc(COPY.corrections.kinds.unlink!));
  });

  it("Why is this linked? says the AI paired the call, with the chip and Correct", () => {
    const join: Api.HierJoinT = {
      interface: "if-ai",
      from: "forge-billing",
      to: "forge-payments",
      how: "unknown",
      gateway: false,
      verified: false,
      method: "POST",
      path: "/charges/{id}/capture",
      caller: [{ source: "ai", repo: "forge-billing", at: "src/ChargeClient.java:41" }],
      callee: [],
      hops: [],
      other: [],
    };
    const out = html(<JoinView join={join} />);
    expect(out).toContain(esc(D.whyLinked));
    expect(out).toContain(esc(D.chip));
    expect(out).toContain('href="#/runs?run=run-match-0007"');
    expect(out).toContain(esc(D.correctOf(LINK.what)));
    expect(out).not.toContain(esc(COPY.why.how.unknown!));
  });

  it("Connect lists what the AI already paired between the two boxes", () => {
    const out = html(<AiPairedBetween from="forge-billing" box={{ repo: "forge-payments" }} />);
    expect(out).toContain(esc(D.betweenTitle(1)));
    expect(out).toContain(esc(LINK.what));
    expect(out).toContain(esc(D.chip));
    expect(html(<AiPairedBetween from="forge-billing" box={{ repo: "forge-cards" }} />)).toBe("");
  });

  it("Match with Copilot says what Atticus applied as the AI's and what it kept as proposals", () => {
    const out = html(
      <MatchDecided
        decided={{
          mode: "auto",
          batch: "b-20261108-101500-a1b2c3",
          applied: [{ call: "call.a", api: "e1", bar: "confident" }],
          kept: [{ call: "call.b", api: "e2", why: "below the bar" }],
        }}
        label={(c) => c}
        apiLabel={(a) => a}
        from="forge-billing"
      />,
    );
    expect(out).toContain(esc(D.matchApplied(1)));
    expect(out).toContain(esc(D.chip));
    expect(out).toContain(esc(D.matchKept(1)));
    expect(out).toContain("below the bar");
    expect(out).toContain('href="#/decisions?repo=forge-billing"');
    const paused = html(
      <MatchDecided
        decided={{ mode: "propose", applied: [], kept: [], paused: "The audit is below the bar." }}
        label={(c) => c}
        apiLabel={(a) => a}
        from="forge-billing"
      />,
    );
    expect(paused).toContain(esc(D.matchPaused("The audit is below the bar.")));
  });
});

describe("Contracts", () => {
  it("marks an interface the AI linked, and splits the links three ways", () => {
    const out = html(<ContractList kind="Interface" title="Interfaces" pick={() => undefined} />);
    expect(out).toContain(esc(D.chip));
    expect((out.match(/chip ai/g) ?? []).length).toBe(1);
    expect(html(<ContractsAiCounts />)).toContain(esc(D.counts.line(VIEW.links.counts)));
  });
});

describe("a change's knowledge", () => {
  it("marks a conflict whose question the AI answered", () => {
    const out = html(
      <ConflictList
        conflicts={[
          {
            key: "k1",
            about: ["refunds"],
            pages: [],
            applies: [],
            question: { id: "q-0123456789ab", state: "answered", repo: "forge-ledger" },
          } as never,
        ]}
      />,
    );
    expect(out).toContain(esc(D.chip));
  });
});

describe("Home and Map › Trust", () => {
  it("Home says why deciding paused, with Trust's link; nothing when it isn't", () => {
    const paused = {
      ...VIEW,
      decide: {
        ...VIEW.decide,
        now: { links: "propose" as const, questions: "propose" as const },
        paused: {
          why: "The audit found 80% right, below 95%.",
          precision: 0.8,
          low: 0.5,
          high: 0.9,
          answered: 10,
          minPrecision: 0.95,
        },
      },
    };
    const out = html(<HomeDecidePaused />, paused);
    expect(out).toContain(esc(D.pausedWhy("The audit found 80% right, below 95%.")));
    expect(out).toContain('href="#/trust"');
    expect(html(<HomeDecidePaused />)).toBe("");
  });

  it("a repo's row shows its AI-decision audit beside the facts' and links'", () => {
    const r: Api.TrustRepoT = {
      repo: "forge-billing",
      facts: { path: "facts/forge-billing.jsonl", present: true, count: 4, unverified: 0 },
      verify: { path: "facts/forge-billing.verify.yaml", report: null },
      checkout: { path: "workspace/forge-billing", present: false },
      sameCommit: null,
      catalog: { from: "facts", fromFacts: 4, fromReaders: 0 },
      state: "trusted",
      audit: {
        path: "facts/forge-billing.audit.yaml",
        facts: tally(9, 1, 0.9),
        byKind: {},
        links: tally(0, 0, null),
        ai: tally(4, 1, 0.8),
      },
    };
    const out = html(<TrustRow r={r} />);
    expect(out).toContain(esc(D.trustTally(tally(4, 1, 0.8))));
  });

  it("the Trust tab shows the estate's AI precision and the bar, with Decided by AI's link", () => {
    const out = html(
      <TrustPage
        of={{ state: "ready", data: { factsDir: "facts", repos: [], problems: [] } }}
        decide={{ state: "ready", data: VIEW }}
      />,
    );
    expect(out).toContain(esc(D.trustTitle));
    expect(out).toContain(esc(D.trustTally(VIEW.decide.precision)));
    expect(out).toContain(esc(D.trustBar(0.95)));
    expect(out).toContain('href="#/decisions"');
  });
});
