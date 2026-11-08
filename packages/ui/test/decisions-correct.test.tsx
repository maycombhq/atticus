import { describe, expect, it, vi } from "vitest";
import type { Api } from "@maycombhq/core";
import { all, mount, text } from "./support/hooks.js";

/**
 * ADR 0181 part 2 in the app: Correct on a "Detected by AI" item previews the answer, the rule it
 * derives and what it spreads to, then saves on the person's click (their approval); Undo asks
 * first and says what it did. Rendered with the tiny hooks runtime, no DOM.
 */

vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});

const { COPY } = await import("../src/copy.js");
const {
  AiMark,
  CorrectDecision,
  DecisionsContext,
  MakeReadingRule,
  SpreadView,
  staticDecisions,
  UndoBatch,
  UndoResultView,
} = await import("../src/app/decisions.js");
const D = COPY.decisions;

const flush = () => new Promise((r) => setTimeout(r, 0));
const els = (tree: unknown) => all(tree);
const button = (tree: unknown, label: string) =>
  els(tree).find((e) => e.type === "button" && text(e.props.children) === label);
const input = (tree: unknown, pred: (p: Record<string, unknown>) => boolean) =>
  els(tree).find((e) => e.type === "input" && pred(e.props));
const click = async (m: { tree: unknown; render(): void }, label: string) => {
  const b = button(m.tree, label);
  if (!b) throw new Error(`no button ${label}: ${text(m.tree)}`);
  (b.props.onClick as () => void)();
  await flush();
  m.render();
};
const submit = async (m: { tree: unknown; render(): void }) => {
  const f = els(m.tree).find((e) => e.type === "form")!;
  (f.props.onSubmit as (e: { preventDefault(): void }) => void)({ preventDefault: () => {} });
  await flush();
  m.render();
};

const ANSWER: Api.AiDecisionItemT = {
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
  at: "2026-11-08T10:20:00Z",
  cites: [],
};
const LINK: Api.AiDecisionItemT = {
  kind: "link",
  item: "link:forge-billing:call.post.charges-capture",
  repo: "forge-billing",
  what: "forge-billing POST captureChargePath → forge-payments POST /charges/{id}/capture",
  decided: "forge-payments.post.charges-capture",
  to: { repo: "forge-payments", path: "/charges/{id}/capture", method: "POST" },
  runtime: "copilot-acp",
  run: "run-match-0007",
  at: "2026-11-08T10:15:00Z",
  cites: [],
};

const result = (
  written: boolean,
  extra: Partial<Api.CorrectDecisionResultT> = {},
): Api.CorrectDecisionResultT => ({
  written,
  ...(written ? { batch: "b-20261108-110000-0f0f0f" } : {}),
  item: ANSWER.item,
  answer: "Northwind Pay",
  rule: { kind: "host", match: "*.northwind.example", derived: true },
  spread: [
    {
      item: "q-aaaaaaaaaaaa",
      repo: "forge-ledger",
      what: "Where does REFUND_URL go?",
      now: "Northwind Pay",
      change: "applied",
    },
  ],
  counts: { applied: 1, confirmed: 0, replaced: 0, reverted: 0 },
  files: ["questions/forge-ledger.yaml"],
  verify: ["atticus verify forge-ledger --write"],
  commit: "git commit",
  ...extra,
});

describe("Correct a Detected by AI answer", () => {
  it("previews first, shows the derived rule and spread, then saves as the person's word", async () => {
    const sent: Api.CorrectDecisionRequestT[] = [];
    const done: Api.CorrectDecisionResultT[] = [];
    const m = mount(
      CorrectDecision as never,
      {
        d: ANSWER,
        post: async (b: Api.CorrectDecisionRequestT) => {
          sent.push(b);
          return b.preview
            ? result(false)
            : result(true, {
                makeRule: {
                  corrections: 3,
                  shape: "*.northwind.example",
                  repo: "forge-ledger",
                  command: "atticus rules draft forge-ledger",
                },
              });
        },
        onDone: (r: Api.CorrectDecisionResultT) => done.push(r),
        onClose: () => undefined,
      } as never,
    );
    const t0 = text(m.tree);
    expect(t0).toContain(D.formTitle(ANSWER.what));
    expect(t0).toContain(D.pickOption);
    // Every option is a labelled radio, with None of these.
    const radios = els(m.tree).filter((e) => e.type === "input" && e.props.type === "radio");
    expect(radios.length).toBe(3);
    expect(t0).toContain("Northwind Pay");
    expect(t0).toContain(D.noneOption);
    // Apply to similar: on by default.
    const similar = input(m.tree, (p) => p.type === "checkbox")!;
    expect(similar.props.checked).toBe(true);
    // Save waits for a preview.
    expect(button(m.tree, D.save)!.props.disabled).toBe(true);
    // Nothing picked: says so.
    await submit(m);
    expect(text(m.tree)).toContain(D.needPick);
    expect(sent).toEqual([]);
    // Pick Northwind Pay, then Preview.
    (radios[1]!.props.onChange as () => void)();
    m.render();
    await submit(m);
    expect(sent).toEqual([{ item: ANSWER.item, option: 2, similar: true, preview: true }]);
    const shown = els(m.tree).find((e) => e.type === SpreadView);
    expect((shown!.props as { r: Api.CorrectDecisionResultT }).r.written).toBe(false);
    // The derived rule is shown, editable, before saving.
    const rule = input(m.tree, (p) => p.value === "*.northwind.example");
    expect(rule).toBeDefined();
    expect(text(m.tree)).toContain(D.approval);
    // Save: the same body, without preview.
    await click(m, D.save);
    expect(sent[1]).toEqual({ item: ANSWER.item, option: 2, similar: true });
    expect(done.length).toBe(1);
    const saved = els(m.tree).find((e) => e.type === SpreadView);
    expect((saved!.props as { saved?: boolean }).saved).toBe(true);
    // The result is announced and takes the focus.
    const status = els(m.tree).find((e) => e.props.role === "status" && e.props.tabIndex === -1);
    expect(status).toBeDefined();
    // Make this a reading rule, offered.
    expect(els(m.tree).some((e) => e.type === MakeReadingRule)).toBe(true);
  });

  it("asks for a fresh preview when the person changes the rule after it", async () => {
    const sent: Api.CorrectDecisionRequestT[] = [];
    const m = mount(
      CorrectDecision as never,
      {
        d: ANSWER,
        post: async (b: Api.CorrectDecisionRequestT) => {
          sent.push(b);
          return result(false);
        },
        onClose: () => undefined,
      } as never,
    );
    const radios = els(m.tree).filter((e) => e.type === "input" && e.props.type === "radio");
    (radios[1]!.props.onChange as () => void)();
    m.render();
    await submit(m);
    const rule = input(m.tree, (p) => p.value === "*.northwind.example")!;
    (rule.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: "*.example" },
    });
    m.render();
    expect(button(m.tree, D.save)!.props.disabled).toBe(true);
    expect(text(m.tree)).toContain(D.changedSince);
    await submit(m);
    expect(sent[1]).toEqual({
      item: ANSWER.item,
      option: 2,
      similar: true,
      match: "*.example",
      preview: true,
    });
  });

  it("says why the server refused, as an alert", async () => {
    const m = mount(
      CorrectDecision as never,
      {
        d: ANSWER,
        post: async () => {
          throw new Error("That isn't an AI decision any more.");
        },
        onClose: () => undefined,
      } as never,
    );
    const radios = els(m.tree).filter((e) => e.type === "input" && e.props.type === "radio");
    (radios[2]!.props.onChange as () => void)();
    m.render();
    await submit(m);
    const alert = els(m.tree).find((e) => e.props.role === "alert");
    expect(text(alert)).toContain("That isn't an AI decision any more.");
  });
});

describe("Correct a Detected by AI pairing", () => {
  it("picks an API of a repo from its list, or None of these", async () => {
    const sent: Api.CorrectDecisionRequestT[] = [];
    const m = mount(
      CorrectDecision as never,
      {
        d: LINK,
        apis: {
          state: "ready",
          data: {
            from: "forge-billing",
            to: { repo: "forge-payments" },
            toName: "forge-payments",
            calls: [],
            apis: [
              {
                id: "forge-payments.post.refunds",
                kind: "route",
                method: "POST",
                path: "/refunds",
              },
            ],
          },
        },
        post: async (b: Api.CorrectDecisionRequestT) => {
          sent.push(b);
          return result(false);
        },
        onClose: () => undefined,
      } as never,
    );
    const t = text(m.tree);
    expect(t).toContain(D.pickLink);
    expect(t).toContain(D.noneLink);
    expect(t).toContain("POST /refunds");
    const repo = input(m.tree, (p) => p.value === "forge-payments")!;
    expect(repo).toBeDefined();
    const select = els(m.tree).find((e) => e.type === "select")!;
    (select.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: "forge-payments.post.refunds" },
    });
    m.render();
    await submit(m);
    expect(sent[0]).toEqual({
      item: LINK.item,
      api: "forge-payments.post.refunds",
      repo: "forge-payments",
      similar: true,
      preview: true,
    });
  });
});

describe("Correct on a chip", () => {
  const view = (items: Api.AiDecisionItemT[]): Api.DecisionsViewT => ({
    decide: {
      configured: { links: "auto", questions: "auto", minPrecision: 0.95 },
      now: { links: "auto", questions: "auto" },
      precision: {
        drawn: 0,
        right: 0,
        wrong: 0,
        unsure: 0,
        open: 0,
        gone: 0,
        precision: null,
        low: null,
        high: null,
      },
    },
    links: { counts: { fromCode: 0, byPerson: 0, byAi: 0 }, items: [] },
    questions: { counts: { fromCode: 0, byPerson: 0, byAi: items.length }, items },
    batches: [],
    problems: [],
  });
  const ctx = DecisionsContext as unknown as { _currentValue: unknown };

  it("opens the form, and keeps it with its result after the item stops being the AI's", async () => {
    const opened: string[] = [];
    ctx._currentValue = staticDecisions(view([ANSWER]));
    const m = mount(
      AiMark as never,
      { item: ANSWER.item, onOpen: (d: Api.AiDecisionItemT) => opened.push(d.item) } as never,
    );
    expect(els(m.tree).some((e) => e.type === CorrectDecision)).toBe(false);
    const correct = els(m.tree).find(
      (e) => e.type === "button" && e.props["aria-label"] === D.correctOf(ANSWER.what),
    )!;
    (correct.props.onClick as () => void)();
    m.render();
    expect(opened).toEqual([ANSWER.item]);
    expect(els(m.tree).some((e) => e.type === CorrectDecision)).toBe(true);
    // Saved: the decisions reload without it (it is the person's now); the form stays.
    ctx._currentValue = staticDecisions(view([]));
    m.render();
    expect(els(m.tree).some((e) => e.type === CorrectDecision)).toBe(true);
    ctx._currentValue = undefined;
  });

  it("shows nothing for an item no AI decided", () => {
    ctx._currentValue = staticDecisions(view([]));
    const m = mount(AiMark as never, { item: "q-ffffffffffff" } as never);
    expect(m.tree).toBeNull();
    ctx._currentValue = undefined;
  });
});

describe("Undo a batch", () => {
  it("asks first, then undoes and says what it did", async () => {
    const asked: string[] = [];
    const m = mount(
      UndoBatch as never,
      {
        b: {
          id: "b-20261108-110000-0f0f0f",
          kind: "rule",
          at: "2026-11-08T11:00:00Z",
          by: "Priya Nair",
          applied: 4,
          reverted: 1,
          file: "decisions/b-20261108-110000-0f0f0f.yaml",
        },
        post: async (id: string) => {
          asked.push(id);
          return {
            batch: id,
            removed: 4,
            restored: 1,
            skipped: [],
            files: [],
            verify: [],
            commit: "git commit",
          };
        },
      } as never,
    );
    await click(m, D.undo);
    expect(asked).toEqual([]);
    expect(text(m.tree)).toContain(D.confirmUndo("b-20261108-110000-0f0f0f", 4));
    await click(m, D.confirmNo);
    expect(text(m.tree)).not.toContain(D.confirmUndo("b-20261108-110000-0f0f0f", 4));
    await click(m, D.undo);
    await click(m, D.confirmYes);
    expect(asked).toEqual(["b-20261108-110000-0f0f0f"]);
    expect(els(m.tree).some((e) => e.type === UndoResultView)).toBe(true);
  });

  it("says why it couldn't, as an alert", async () => {
    const m = mount(
      UndoBatch as never,
      {
        b: {
          id: "b-20261108-110000-0f0f0f",
          kind: "ai",
          at: "2026-11-08T11:00:00Z",
          by: "AI (copilot-acp, run r1)",
          applied: 1,
          reverted: 0,
          file: "decisions/b.yaml",
        },
        post: async () => {
          throw new Error("already undone");
        },
      } as never,
    );
    await click(m, D.undo);
    await click(m, D.confirmYes);
    const alert = els(m.tree).find((e) => e.props.role === "alert");
    expect(text(alert)).toContain(D.undoFailed("already undone"));
  });
});
