import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { screenOf, tabsOf } from "../src/app/screens.js";
import { COPY } from "../src/copy.js";
import {
  AiChip,
  correctBody,
  DecidePaused,
  DecisionsContext,
  isAiBy,
  linkDecisionAt,
  MakeReadingRuleView,
  SplitCounts,
  SpreadView,
  staticDecisions,
  UndoResultView,
} from "../src/app/decisions.js";
import {
  batchKindOf,
  decideWhere,
  decisionsShown,
  DecisionsPage,
} from "../src/screens/map/Decisions.js";

/**
 * ADR 0181 parts 1 to 3, the screens: every AI decision carries "Detected by AI" (words, never
 * colour alone) with its run linked; Correct previews the derived rule and its spread before
 * saving; Map › Decided by AI lists the decisions and the batches, each one Undo away.
 */

const D = COPY.decisions;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

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

export const LINK: Api.AiDecisionItemT = {
  kind: "link",
  item: "link:forge-billing:call.post.charges-capture",
  repo: "forge-billing",
  what: "forge-billing POST captureChargePath → forge-payments POST /charges/{id}/capture",
  decided: "forge-payments.post.charges-capture",
  call: {
    fact: "call.post.charges-capture",
    file: "src/main/java/forge/billing/ChargeClient.java",
    line: 41,
    value: "captureChargePath",
  },
  to: {
    repo: "forge-payments",
    entry: "forge-payments.post.charges-capture",
    method: "POST",
    path: "/charges/{id}/capture",
  },
  runtime: "copilot-acp",
  run: "run-match-0007",
  bar: "confident",
  batch: "b-20261108-101500-a1b2c3",
  at: "2026-11-08T10:15:00Z",
  cites: ["forge-billing src/main/java/forge/billing/ChargeClient.java:41"],
};
export const ANSWER: Api.AiDecisionItemT = {
  kind: "question",
  item: "q-0123456789ab",
  repo: "forge-ledger",
  what: "Where does forge-ledger's NOTIFY_URL call go?",
  decided: "forge-notify",
  question: {
    text: "Where does forge-ledger's NOTIFY_URL call go?",
    option: 1,
    options: ["forge-notify", "Northwind Pay"],
  },
  runtime: "copilot-acp",
  run: "run-propose-0003",
  bar: "agrees-with-shapes",
  batch: "b-20261108-102000-d4e5f6",
  at: "2026-11-08T10:20:00Z",
  cites: ["forge-ledger src/notify.ts:12"],
};

const VIEW: Api.DecisionsViewT = {
  decide: {
    configured: { links: "auto", questions: "auto", minPrecision: 0.95 },
    now: { links: "auto", questions: "auto" },
    precision: tally(19, 1, 0.95),
  },
  links: { counts: { fromCode: 40, byPerson: 3, byAi: 1 }, items: [LINK] },
  questions: { counts: { fromCode: 5, byPerson: 2, byAi: 1, open: 7 }, items: [ANSWER] },
  batches: [
    {
      id: "b-20261108-110000-0f0f0f",
      kind: "rule",
      at: "2026-11-08T11:00:00Z",
      by: "Priya Nair",
      applied: 4,
      reverted: 1,
      correction: {
        item: "link:forge-billing:call.get.invoices",
        answer: "forge-invoices GET /invoices",
        rule: { kind: "path", match: "src/main/java/forge/billing/**", from: "link" },
      },
      file: "decisions/b-20261108-110000-0f0f0f.yaml",
    },
    {
      id: "b-20261108-101500-a1b2c3",
      kind: "ai",
      at: "2026-11-08T10:15:00Z",
      by: "AI (copilot-acp, run run-match-0007)",
      run: "run-match-0007",
      applied: 1,
      reverted: 0,
      undone: { by: "Sam Okafor", at: "2026-11-08T12:00:00Z" },
      file: "decisions/b-20261108-101500-a1b2c3.yaml",
    },
  ],
  problems: [],
};

describe("the Detected by AI chip", () => {
  it("says it in words with a shape and a spoken why, and links the run to the Runs page", () => {
    const out = html(<AiChip run="run-match-0007" />);
    expect(out).toContain("chip ai");
    expect(out).toContain(esc(D.chip));
    expect(out).toContain(esc(D.chipWhy));
    expect(out).toContain('href="#/runs?run=run-match-0007"');
    expect(out).toContain(esc(D.openRun("run-match-0007")));
  });

  it("inside a link or a button, links nothing (no link in a link)", () => {
    const out = html(<AiChip run="run-match-0007" inLink />);
    expect(out).toContain(esc(D.chip));
    expect(out).not.toContain("<a ");
  });

  it("tells an AI's by from a person's", () => {
    expect(isAiBy({ kind: "ai", runtime: "copilot-acp", run: "r1" })).toBe(true);
    expect(isAiBy("Priya Nair")).toBe(false);
    expect(isAiBy(undefined)).toBe(false);
  });

  it("finds the AI's pairing of a call by its repo and line", () => {
    const d = staticDecisions(VIEW);
    const view = d.view?.state === "ready" ? d.view.data : undefined;
    expect(
      linkDecisionAt(view, "forge-billing", "src/main/java/forge/billing/ChargeClient.java:41"),
    ).toEqual(LINK);
    expect(linkDecisionAt(view, "forge-billing", "src/Other.java:1")).toBeUndefined();
  });
});

describe("counts split three ways", () => {
  it("says from code, by a person and by AI, with the open ones when there are", () => {
    const out = html(<SplitCounts counts={VIEW.questions.counts} what={D.counts.questions} />);
    expect(out).toContain(esc(D.counts.line(VIEW.questions.counts)));
    expect(out).toContain("7 open");
    expect(out).toContain(`aria-label="${esc(D.counts.label(D.counts.questions))}"`);
    expect(html(<SplitCounts counts={VIEW.links.counts} what={D.counts.links} />)).not.toContain(
      "open",
    );
  });
});

describe("Correct: the body sent", () => {
  it("sends the option for a question, with Apply to similar on by default and preview first", () => {
    expect(
      correctBody(ANSWER, { pick: "option", option: 2, repo: "", api: "", similar: true }, true),
    ).toEqual({ body: { item: ANSWER.item, option: 2, similar: true, preview: true } });
  });

  it("sends the API and its repo for a pairing, or none; a rule the person changed rides along", () => {
    expect(
      correctBody(
        LINK,
        {
          pick: "api",
          repo: "forge-invoices",
          api: "forge-invoices.post.charges",
          similar: true,
          match: "src/main/java/forge/**",
        },
        false,
      ),
    ).toEqual({
      body: {
        item: LINK.item,
        api: "forge-invoices.post.charges",
        repo: "forge-invoices",
        similar: true,
        match: "src/main/java/forge/**",
      },
    });
    expect(correctBody(LINK, { pick: "none", repo: "", api: "", similar: false }, true)).toEqual({
      body: { item: LINK.item, none: true, similar: false, preview: true },
    });
  });

  it("says what is missing, in words", () => {
    expect(correctBody(ANSWER, { repo: "", api: "", similar: true }, true)).toEqual({
      error: D.needPick,
    });
    expect(correctBody(LINK, { pick: "api", repo: "", api: "x", similar: true }, true)).toEqual({
      error: D.needApi,
    });
  });
});

const RESULT: Api.CorrectDecisionResultT = {
  written: false,
  item: LINK.item,
  answer: "forge-invoices POST /charges",
  rule: { kind: "path", match: "src/main/java/forge/billing/**", derived: true },
  spread: [
    {
      item: "link:forge-billing:call.post.refunds",
      repo: "forge-billing",
      what: "forge-billing POST refundPath",
      was: "forge-payments POST /refunds",
      now: "forge-invoices POST /refunds",
      change: "replaced",
    },
    {
      item: "link:forge-billing:call.get.receipt",
      repo: "forge-billing",
      what: "forge-billing GET receiptPath",
      was: "forge-payments GET /receipts",
      change: "reverted",
    },
  ],
  counts: { applied: 0, confirmed: 0, replaced: 1, reverted: 1 },
  files: ["facts/forge-billing.corrections.jsonl"],
  verify: ["atticus verify forge-billing --write"],
  commit: "git add facts/forge-billing.corrections.jsonl && git commit -m 'Correct a pairing'",
};

describe("Correct: what it spreads to", () => {
  it("shows the derived rule and each item it re-checks, before saving", () => {
    const out = html(<SpreadView r={RESULT} />);
    expect(out).toContain(esc(D.yourAnswer(RESULT.answer)));
    expect(out).toContain(esc(D.rule("path", "src/main/java/forge/billing/**", true)));
    expect(out).toContain(esc(D.spreadCounts(RESULT.counts)));
    expect(out).toContain(esc(D.change.replaced!));
    expect(out).toContain(esc(D.change.reverted!));
    expect(out).toContain(esc("forge-billing POST refundPath"));
    expect(out).toContain(`<caption class="sr">${esc(D.spreadCaption)}</caption>`);
    // Not saved yet: no files or commands.
    expect(out).not.toContain("atticus verify forge-billing --write");
  });

  it("says why no rule spreads, and that nothing else changes", () => {
    const { rule: _r, ...rest } = RESULT;
    const out = html(
      <SpreadView
        r={{
          ...rest,
          noRule: "the rule would be /**",
          spread: [],
          counts: { applied: 0, confirmed: 0, replaced: 0, reverted: 0 },
        }}
      />,
    );
    expect(out).toContain(esc(D.noRule("the rule would be /**")));
    expect(out).toContain(esc(D.spreadNone));
  });

  it("once saved, says it is the person's word, the batch, and the commands", () => {
    const out = html(
      <SpreadView r={{ ...RESULT, written: true, batch: "b-20261108-110000-0f0f0f" }} saved />,
    );
    expect(out).toContain(esc(D.saved(RESULT.answer)));
    expect(out).toContain(esc(D.savedBatch("b-20261108-110000-0f0f0f")));
    expect(out).toContain(esc(D.whatSpread));
    // Ninth UX walk: Home's Apply and Propose for review in place, the commands under a terminal.
    expect(out).toContain(esc(D.next));
    expect(out).toContain(esc(COPY.propose.apply("forge-billing")));
    expect(out).toContain(esc(D.terminal));
    expect(out).toContain("atticus verify forge-billing --write");
    expect(out).toContain(esc(RESULT.commit));
  });

  it("offers Make this a reading rule with the pairing line, or the command for a question", () => {
    const line = html(
      <MakeReadingRuleView
        m={{
          corrections: 3,
          shape: "src/main/java/forge/billing/**",
          repo: "forge-billing",
          line: '{"v":2,"action":"link"}',
        }}
        state={{ state: "idle" }}
        onMake={() => undefined}
      />,
    );
    expect(line).toContain(esc(D.makeRuleOffer(3, "src/main/java/forge/billing/**")));
    expect(line).toContain(esc(D.makeRule));
    const cmd = html(
      <MakeReadingRuleView
        m={{
          corrections: 3,
          shape: "NOTIFY_*",
          repo: "forge-ledger",
          command: "atticus rules draft forge-ledger",
        }}
        state={{ state: "idle" }}
        onMake={() => undefined}
      />,
    );
    expect(cmd).not.toContain(esc(D.makeRule));
    expect(cmd).toContain("atticus rules draft forge-ledger");
    const made = html(
      <MakeReadingRuleView
        m={{ corrections: 3, shape: "x", repo: "forge-billing", line: "{}" }}
        state={{
          state: "made",
          made: {
            file: "org-pack/rules/java-spring.yaml",
            key: "k",
            rule: "r",
            activate: "atticus rules activate k",
          },
        }}
        onMake={() => undefined}
      />,
    );
    expect(made).toContain(esc(D.ruleMade("org-pack/rules/java-spring.yaml")));
    expect(made).toContain("atticus rules activate k");
  });
});

describe("Undo a batch", () => {
  it("says what it removed and put back, and what it left as it is now", () => {
    const out = html(
      <UndoResultView
        r={{
          batch: "b-20261108-110000-0f0f0f",
          removed: 4,
          restored: 2,
          skipped: ["q-0123456789ab was answered by Priya Nair since"],
          files: ["decisions/b-20261108-110000-0f0f0f.yaml"],
          verify: ["atticus verify forge-billing --write"],
          commit: "git commit",
        }}
      />,
    );
    expect(out).toContain('role="status"');
    expect(out).toContain(esc(D.undoneResult("b-20261108-110000-0f0f0f", 4, 2)));
    expect(out).toContain(esc(D.skipped));
    expect(out).toContain(esc("q-0123456789ab was answered by Priya Nair since"));
    expect(out).toContain("atticus verify forge-billing --write");
    // Ninth UX walk: Apply in place, and the result takes the focus.
    expect(out).toContain(esc(COPY.propose.apply("forge-billing")));
    expect(out).toContain('tabindex="-1"');
  });
});

describe("Home and Trust: the pause", () => {
  it("says nothing when deciding isn't paused", () => {
    expect(html(<DecidePaused decide={VIEW.decide} />)).toBe("");
  });
  it("says why it paused, with a link to Map › Trust", () => {
    const out = html(
      <DecidePaused
        decide={{
          ...VIEW.decide,
          now: { links: "propose", questions: "propose" },
          paused: {
            why: "The sample audit found 80% of the AI's decisions right, below the bar of 95%.",
            precision: 0.8,
            low: 0.5,
            high: 0.95,
            answered: 10,
            minPrecision: 0.95,
          },
        }}
      />,
    );
    expect(out).toContain(esc(D.pausedTitle));
    expect(out).toContain(
      esc(
        D.pausedWhy(
          "The sample audit found 80% of the AI's decisions right, below the bar of 95%.",
        ),
      ),
    );
    expect(out).toContain('href="#/trust"');
    expect(out).toContain(esc(D.pausedLink));
  });
});

describe("Map › Decided by AI", () => {
  it("is a tab of Map, found by its name", () => {
    expect(screenOf("decisions").section).toBe("Map");
    expect(screenOf("decisions").label).toBe(COPY.nav.screens.decisions);
    expect(tabsOf("Map").map((t) => t.id)).toContain("decisions");
  });

  it("filters by repo and kind", () => {
    const items = [LINK, ANSWER];
    expect(decisionsShown(items, { repo: "", kind: "" })).toEqual(items);
    expect(decisionsShown(items, { repo: "forge-ledger", kind: "" })).toEqual([ANSWER]);
    expect(decisionsShown(items, { repo: "", kind: "link" })).toEqual([LINK]);
    expect(decisionsShown(items, { repo: "forge-ledger", kind: "link" })).toEqual([]);
  });

  const page = (of: Parameters<typeof DecisionsPage>[0]["of"], o: { repo?: string } = {}) =>
    html(
      <DecisionsContext.Provider value={staticDecisions(VIEW)}>
        <DecisionsPage
          of={of}
          repo={o.repo ?? ""}
          kind=""
          onRepo={() => undefined}
          onKind={() => undefined}
        />
      </DecisionsContext.Provider>,
    );

  it("lists each decision with its chip, run, bar, lines and Correct; counts split three ways", () => {
    const out = page({ state: "ready", data: VIEW });
    expect(out).toContain(esc(D.chip));
    expect(out).toContain('href="#/runs?run=run-match-0007"');
    expect(out).toContain('href="#/runs?run=run-propose-0003"');
    expect(out).toContain(esc(LINK.what));
    expect(out).toContain(esc(D.decided("forge-notify")));
    expect(out).toContain(esc(D.because(D.bar.confident!)));
    expect(out).toContain("ChargeClient.java:41");
    expect(out).toContain(esc(D.correctOf(LINK.what)));
    expect(out).toContain(esc(D.counts.line(VIEW.links.counts)));
    expect(out).toContain(esc(D.counts.line(VIEW.questions.counts)));
    expect(out).toContain(esc(D.modeLine(D.mode.auto!, D.mode.auto!)));
    expect(out).toContain('<label for="decisions-repo"');
    expect(out).toContain('<label for="decisions-kind"');
  });

  it("lists the batches newest first with Undo, and an undone one as undone", () => {
    const out = page({ state: "ready", data: VIEW });
    expect(out).toContain(esc(D.batchesTitle));
    expect(out).toContain(esc(D.batchKind.rule!));
    expect(out).toContain(esc(D.batchApplied(4, 1)));
    expect(out).toContain(
      esc(D.batchFrom("link:forge-billing:call.get.invoices", "forge-invoices GET /invoices")),
    );
    expect(out).toContain(esc(D.batchRule("path", "src/main/java/forge/billing/**")));
    expect(out).toContain(esc(D.undoOf("b-20261108-110000-0f0f0f")));
    expect(out).toContain(esc(D.undone("Sam Okafor", "2026-11-08")));
    expect(out).not.toContain(esc(D.undoOf("b-20261108-101500-a1b2c3")));
    expect(out.indexOf("b-20261108-110000-0f0f0f")).toBeLessThan(
      out.indexOf("b-20261108-101500-a1b2c3"),
    );
  });

  it("has loading, error, empty and filtered-empty states", () => {
    expect(page({ state: "loading" })).toContain('aria-busy="true"');
    const err = page({ state: "error", error: "offline" });
    expect(err).toContain('role="alert"');
    const empty = page({
      state: "ready",
      data: {
        ...VIEW,
        links: { ...VIEW.links, items: [] },
        questions: { ...VIEW.questions, items: [] },
        batches: [],
      },
    });
    expect(empty).toContain(esc(D.itemsEmpty));
    expect(empty).toContain(esc(D.batchesEmpty));
    expect(page({ state: "ready", data: VIEW }, { repo: "forge-cards" })).toContain(
      esc(D.itemsFiltered),
    );
  });

  it("says honestly where deciding happens, as runtime.yaml allows the runs (ninth UX walk)", () => {
    const at = (decideIn: ("copilot-acp" | "hand-off")[] | undefined) =>
      decideWhere({ ...VIEW.decide, ...(decideIn ? { decideIn } : {}) });
    expect(at(["copilot-acp", "hand-off"])).toBe(D.decideIn.both);
    expect(at(["hand-off"])).toBe(D.decideIn.handoff);
    expect(at(["copilot-acp"])).toBe(D.decideIn.acp);
    expect(at([])).toBe(D.decideIn.none);
    expect(at(undefined)).toBeUndefined();
    expect(
      decideWhere({
        ...VIEW.decide,
        now: { links: "propose", questions: "propose" },
        decideIn: [],
      }),
    ).toBeUndefined();
    const out = page({
      state: "ready",
      data: { ...VIEW, decide: { ...VIEW.decide, decideIn: ["hand-off"] } },
    });
    expect(out).toContain(esc(D.decideIn.handoff));
    expect(out).toContain('href="#/ai"');
  });

  it("labels the links' counts the map as last applied, and says the standing lines when they differ", () => {
    const out = page({
      state: "ready",
      data: {
        ...VIEW,
        links: {
          ...VIEW.links,
          counts: { fromCode: 0, byPerson: 1, byAi: 0 },
          lines: { byAi: 1, byPerson: 0 },
        },
      },
    });
    expect(out).toContain(esc(D.counts.linksInMap));
    expect(out).toContain(esc(D.counts.lines(1, 0)));
    const same = page({
      state: "ready",
      data: { ...VIEW, links: { ...VIEW.links, lines: { byAi: 1, byPerson: 3 } } },
    });
    expect(same).not.toContain(esc(D.counts.lines(1, 3)));
  });

  it("counts retired questions as retired, never as from code", () => {
    const line = D.counts.line({ fromCode: 0, byPerson: 2, byAi: 3, open: 1, retired: 5 });
    expect(line).toBe("2 by a person · 3 by AI · 1 open · 5 retired");
    expect(line).not.toContain("from code");
  });

  it("labels a lone correction's batch a person's correction, and compacts the AI's chip", () => {
    const lone: Api.DecisionBatchViewT = {
      ...VIEW.batches[0]!,
      correction: { item: "q-0123456789ab", answer: "card-vault" },
    };
    expect(batchKindOf(lone)).toBe(D.batchKind.correction);
    expect(batchKindOf(VIEW.batches[0]!)).toBe(D.batchKind.rule);
    expect(batchKindOf(VIEW.batches[1]!)).toBe(D.batchKind.ai);
    const out = page({ state: "ready", data: { ...VIEW, batches: [lone, VIEW.batches[1]!] } });
    expect(out).toContain(esc(D.batchKind.correction!));
    expect(out).not.toContain(esc(D.batchKind.rule!));
    // The batch row's chip says "By AI" and its run, not the whole sentence again.
    const short = html(<AiChip run="run-match-0007" short />);
    expect(short).toContain(esc(D.chipShort));
    expect(short).not.toContain(esc(D.chipWhy));
    expect(short).toContain('href="#/runs?run=run-match-0007"');
  });

  it("shows the pause on the page too, and files it couldn't read", () => {
    const out = page({
      state: "ready",
      data: {
        ...VIEW,
        decide: {
          ...VIEW.decide,
          paused: {
            why: "Below the bar.",
            precision: 0.8,
            low: 0.5,
            high: 0.9,
            answered: 10,
            minPrecision: 0.95,
          },
        },
        problems: [{ file: "decisions/b-bad.yaml", message: "can't read YAML" }],
      },
    });
    expect(out).toContain(esc(D.pausedTitle));
    expect(out).toContain("decisions/b-bad.yaml");
  });
});
