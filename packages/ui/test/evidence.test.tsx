import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import {
  Citation,
  CitationDetails,
  CorrectFactForm,
  correctionBody,
  EvidenceContext,
  evidenceGaps,
  gapsOfEvidence,
  hitsAt,
  splitAt,
  staticEvidence,
  type FactsView,
} from "../src/app/evidence.js";
import { withEvidenceGaps, type Views } from "../src/screens/architecture/model.js";
import { SequenceDiagram } from "../src/screens/flows/Flows.js";

/** The Map with its evidence (ADR 0124 addendum D-app, F3): citations, gaps and Correct this. */

const E = COPY.evidence;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const ACCOUNT = "src/main/java/forge/ledger/AccountController.java";
const fact = (o: Partial<Api.FactCiteViewT> = {}): Api.FactCiteViewT => ({
  id: "e-get-account",
  kind: "entry",
  label: "GET /accounts/{accountId}",
  claim: {
    method: "GET",
    path: "/accounts/{accountId}",
    handler: "AccountController.get",
    value: "/accounts/{accountId}",
  },
  cite: {
    file: ACCOUNT,
    line: 18,
    value: "/accounts/{accountId}",
    quote: '@GetMapping("/accounts/{accountId}")',
  },
  verified: "line",
  by: "assistant",
  ...o,
});
const VIEW: FactsView = {
  repo: "forge-ledger",
  file: "facts/forge-ledger.jsonl",
  present: true,
  commit: "0123abc",
  facts: [
    fact(),
    fact({
      id: "e-settle",
      label: "forge.payments.settled",
      cite: { file: "src/Settle.java", line: 14, value: "forge.payments.settled" },
      verified: "none",
    }),
    fact({
      id: "w-post",
      kind: "flow",
      label: "Post an entry",
      cite: { file: "src/Entry.java", line: 22, value: "/entries" },
      steps: [{ file: "src/EntryRepo.java", line: 9, value: "entries", what: "Saves the entry" }],
    }),
  ],
  corrections: { file: "facts/forge-ledger.corrections.jsonl", count: 0, stale: [] },
  questions: [
    { id: "q-0123456789ab", question: "Is the listener on?", evidence: ["src/Settle.java:14"] },
  ],
  verify: "atticus verify forge-ledger",
  problems: [],
};
const ready = { state: "ready" as const, data: VIEW };
const withFacts = (
  node: ReactNode,
  views: Record<string, Parameters<typeof staticEvidence>[0][string]> = { "forge-ledger": ready },
) => <EvidenceContext.Provider value={staticEvidence(views)}>{node}</EvidenceContext.Provider>;

describe("the facts on a line, and what evidence lacks", () => {
  it("finds a fact by its own line and a flow's step by its line, and splits path:line", () => {
    expect(splitAt(`${ACCOUNT}:18`)).toEqual({ file: ACCOUNT, line: 18 });
    expect(splitAt("README.md")).toBeUndefined();
    expect(hitsAt(VIEW, ACCOUNT, 18).map((h) => h.fact.id)).toEqual(["e-get-account"]);
    expect(hitsAt(VIEW, "src/EntryRepo.java", 9)).toEqual([
      expect.objectContaining({ step: "Saves the entry" }),
    ]);
  });

  it("is unproven with no verified fact on its lines, says an open question, and a correction not yet applied", () => {
    expect(evidenceGaps(VIEW, [{ file: ACCOUNT, line: 18 }])).toEqual([]);
    expect(evidenceGaps(VIEW, [{ file: "src/Settle.java", line: 14 }])).toEqual([
      "unverified",
      "question",
    ]);
    expect(evidenceGaps(VIEW, [{ file: "src/Other.java", line: 1 }])).toEqual(["unverified"]);
    const corrected: FactsView = {
      ...VIEW,
      facts: [
        fact({
          correction: {
            schemaVersion: 1,
            fact: "e-get-account",
            target: { kind: "entry", file: ACCOUNT, line: 18, value: "/accounts/{accountId}" },
            action: "wrong",
            reason: "gone",
            by: "pat",
            at: "2026-10-24T10:00:00Z",
          },
        }),
      ],
    };
    expect(evidenceGaps(corrected, [{ file: ACCOUNT, line: 18 }])).toEqual(["corrected"]);
    // Nothing is said before the repo's facts are loaded.
    expect(evidenceGaps(undefined, [{ file: ACCOUNT, line: 18 }])).toEqual([]);
  });

  it("weighs a record's evidence across repos, and a box with a record but nothing cited", () => {
    const of = (r: string) => (r === "forge-ledger" ? VIEW : undefined);
    expect(gapsOfEvidence([{ repo: "forge-ledger", at: `${ACCOUNT}:18` }], of)).toEqual([]);
    expect(
      gapsOfEvidence([{ repo: "forge-ledger", path: "src/Settle.java", line: 14 }], of),
    ).toEqual(["question", "unverified"]);
    // A repo whose facts aren't loaded says nothing.
    expect(gapsOfEvidence([{ repo: "forge-gateway", at: "a.ts:1" }], of)).toEqual([]);
    expect(gapsOfEvidence([], of, { bare: true })).toEqual(["unverified"]);
    expect(gapsOfEvidence([], of)).toEqual([]);
  });

  it("adds the gaps to the canvas's boxes and links", () => {
    const node = (id: string, at?: string) => ({
      id,
      kind: "component" as const,
      label: id,
      childCount: 0,
      state: "current" as const,
      gaps: [],
      evidence: at ? [{ source: "code", repo: "forge-ledger", at }] : [],
      properties: {},
      record: { kind: "Component", id: id.split(":")[1]! },
    });
    const views: Views = new Map([
      [
        "estate",
        {
          lens: "architecture",
          node: {
            ...node("estate"),
            kind: "estate",
            record: undefined,
          } as unknown as Api.HierNodeT,
          path: [],
          children: [
            node("component:ledger-api", `${ACCOUNT}:18`),
            node("component:settler", "src/Settle.java:14"),
            node("component:bare"),
          ],
          outside: [],
          edges: [
            {
              id: "e1",
              from: "component:settler",
              to: "component:ledger-api",
              type: "calls",
              count: 1,
              state: "current",
              gaps: [],
              evidence: [{ source: "code", repo: "forge-ledger", at: "src/Settle.java:14" }],
            },
          ],
          reduced: true,
          hiddenEdges: 0,
        } as Api.GraphNodeViewT,
      ],
    ]);
    const out = withEvidenceGaps(views, (r) => (r === "forge-ledger" ? VIEW : undefined)).get(
      "estate",
    )!;
    expect(out.children.map((c) => [c.id, c.gaps])).toEqual([
      ["component:ledger-api", []],
      ["component:settler", ["question", "unverified"]],
      ["component:bare", ["unverified"]],
    ]);
    expect(out.edges[0]!.gaps).toEqual(["question", "unverified"]);
  });
});

describe("a citation", () => {
  it("is a button whose tooltip gives the place, the quote and who checked the fact", () => {
    const out = renderToStaticMarkup(
      withFacts(<Citation repo="forge-ledger" at={`${ACCOUNT}:18`} />),
    );
    expect(out).toMatch(/<button[^>]*aria-describedby="[^"]+"[^>]*aria-expanded="false"/);
    expect(out).toContain(`aria-label="${esc(E.citeOf(`${ACCOUNT}:18`, "forge-ledger"))}"`);
    expect(out).toContain('role="tooltip"');
    expect(out).toContain(esc('@GetMapping("/accounts/{accountId}")'));
    expect(out).toContain(esc(E.verified.line!));
    expect(out).toContain(esc(E.by.assistant!));
    expect(out).not.toContain(esc(E.gaps.unverified!));
  });

  it("marks a gap with a shape and words, not colour alone, in the button and the tooltip", () => {
    const out = renderToStaticMarkup(
      withFacts(<Citation repo="forge-ledger" at="src/Settle.java:14" />),
    );
    expect(out).toContain("ev-cite gappy");
    expect(out).toContain("△");
    expect(out).toContain(esc(E.short.unverified!));
    expect(out).toContain(esc(E.gaps.unverified!));
    expect(out).toContain(esc(E.gaps.question!));
    expect(out).toContain(esc(E.verified.none!));
  });

  it("says when the repo has no facts or they are loading, and is the file and line without facts at all", () => {
    const none = renderToStaticMarkup(
      withFacts(<Citation repo="forge-gateway" at="a.ts:1" />, {
        "forge-gateway": {
          state: "ready",
          data: { ...VIEW, repo: "forge-gateway", present: false, facts: [], questions: [] },
        },
      }),
    );
    expect(none).toContain(esc(E.noFacts("forge-gateway")));
    const loading = renderToStaticMarkup(
      withFacts(<Citation repo="x" at="a.ts:1" />, { x: { state: "loading" } }),
    );
    expect(loading).toContain(esc(E.loading));
    const bare = renderToStaticMarkup(<Citation at="a.ts:1" />);
    expect(bare).toContain("a.ts:1");
    expect(bare).not.toContain("gappy");
  });

  it("opens the facts on the line with Correct this, and the questions that read it", () => {
    const out = renderToStaticMarkup(
      <CitationDetails
        repo="forge-ledger"
        at="src/Settle.java:14"
        of={ready}
        onClose={() => undefined}
      />,
    );
    expect(out).toContain(`aria-label="${esc(E.correctFact("forge.payments.settled"))}"`);
    expect(out).toContain('href="#/questions/q-0123456789ab"');
    expect(out).toContain(esc(E.close));
  });

  it("is on every flow step that cites a line, with the flow's repo", () => {
    const seq = {
      lanes: [
        { id: "caller", label: "Caller", kind: "caller" as const },
        { id: "self", label: "ledger-api", kind: "self" as const },
      ],
      rows: [
        {
          n: 1,
          shown: "1",
          kind: "write",
          what: "Saves the entry",
          from: "self",
          to: "self",
          back: false,
          fields: [],
          cite: "src/EntryRepo.java:9",
          more: 0,
          frames: [],
          confirmedBy: "line",
        },
      ],
      frames: [],
      errors: [],
      gaps: [],
    };
    const out = renderToStaticMarkup(
      withFacts(<SequenceDiagram seq={seq} name="Post" repo="forge-ledger" hideErrors />),
    );
    expect(out).toContain('role="tooltip"');
    expect(out).toContain("Saves the entry");
    expect(out).toContain(esc(E.citeOf("src/EntryRepo.java:9", "forge-ledger")));
  });
});

describe("correcting a fact", () => {
  it("needs why to mark it wrong, and only what changed to correct it", () => {
    const f = fact();
    expect(correctionBody(f, { action: "wrong", reason: " ", set: {}, line: "18" })).toEqual({
      error: E.needReason,
    });
    expect(correctionBody(f, { action: "wrong", reason: "gone", set: {}, line: "18" })).toEqual({
      body: { fact: "e-get-account", action: "wrong", reason: "gone" },
    });
    expect(
      correctionBody(f, { action: "edit", reason: "", set: { ...f.claim }, line: "18" }),
    ).toEqual({ error: E.nothingChanged });
    expect(
      correctionBody(f, {
        action: "edit",
        reason: "",
        set: { ...f.claim, handler: "AccountController.read" },
        line: "19",
      }),
    ).toEqual({
      body: {
        fact: "e-get-account",
        action: "edit",
        set: { handler: "AccountController.read" },
        line: 19,
      },
    });
  });

  it("shows the form, then the git and verify commands, or why it failed", () => {
    const form = (saving: Parameters<typeof CorrectFactForm>[0]["saving"]) =>
      renderToStaticMarkup(
        <CorrectFactForm
          repo="forge-ledger"
          fact={fact()}
          {...(saving ? { saving } : {})}
          onClose={() => undefined}
        />,
      );
    const idle = form(undefined);
    expect(idle).toContain(esc(E.correctTitle("GET /accounts/{accountId}")));
    expect(idle).toContain(esc(E.wrong));
    expect(idle).toContain(esc(E.edit));
    expect(idle).toContain(esc(E.reason));
    expect(form({ state: "working" })).toContain('aria-busy="true"');
    expect(form({ state: "error", text: "nope" })).toContain('role="alert"');
    const done = form({
      state: "done",
      result: {
        correction: {
          schemaVersion: 1,
          fact: "e-get-account",
          target: { kind: "entry", file: ACCOUNT, line: 18, value: "/x" },
          action: "wrong",
          reason: "gone",
          by: "pat",
          at: "2026-10-24T10:00:00Z",
        },
        file: "facts/forge-ledger.corrections.jsonl",
        commit: 'git add facts/forge-ledger.corrections.jsonl && git commit -m "x"',
        verify: "atticus verify forge-ledger",
      },
    });
    expect(done).toContain(esc(E.saved("facts/forge-ledger.corrections.jsonl")));
    expect(done).toContain("git add facts/forge-ledger.corrections.jsonl");
    expect(done).toContain("atticus verify forge-ledger");
  });
});
