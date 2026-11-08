import { describe, expect, it } from "vitest";
import type { ChangeLifecycleInput } from "@maycombhq/core";
import { mergeChangeRecords, mergeChangeText, serializeChange } from "../src/index.js";

/**
 * Ninth UX walk: after a hand-off merged, Bring in refused with "What merged also changes
 * change.yaml where your copy changed it": Sync here had moved the state and added the hand-off's
 * entries, and the hand-off branch's copy had too, so a text merge of the record clashed. The
 * record is Atticus's own: it is merged by its fields.
 */

const ID = "let-tellers-lock-a-card";
const T = (h: string) => `2026-11-08T${h}:00Z`;
const handoff = (
  phase: string,
  n: number,
  state: string,
  at: string,
  approvals: string[] = [],
) => ({
  phase,
  branch: `handoff/${ID}/${phase}`,
  pr: { number: n, url: `https://git.forge.example/pr/${n}` },
  state,
  by: "ada",
  openedAt: at,
  updatedAt: at,
  reviewers: [],
  approvals: approvals.map((by) => ({ by, at })),
  artifacts: [],
});
const step = (from: string, to: string, at: string, pr?: number) => ({
  from,
  to,
  at,
  by: "ada",
  ...(pr ? { pr } : {}),
});

/** The record as main had it when the define hand-off merged (this copy's HEAD). */
const base = {
  schemaVersion: 1,
  id: ID,
  title: "Let tellers lock a card",
  type: "feature",
  template: "feature",
  state: "define",
  owners: { "product-owner": ["ada"] },
  systems: ["cards"],
  authors: {},
  createdAt: T("22:00"),
  createdBy: "ada",
  history: [step("draft", "define", T("22:00"))],
  handoffs: [],
} as unknown as ChangeLifecycleInput;

/** The design hand-off branch's copy: the define hand-off merged, the change at design. */
const theirs = {
  ...base,
  state: "design",
  authors: { brief: ["ada"], proposal: ["ada"] },
  history: [...base.history!, step("define", "design", T("22:32"), 102)],
  handoffs: [handoff("define", 102, "merged", T("22:32"), ["bo"])],
} as unknown as ChangeLifecycleInput;

/** This copy after Sync read the design hand-off merged: at plan, both hand-offs merged. */
const ours = {
  ...theirs,
  state: "plan",
  authors: { brief: ["ada"], proposal: ["ada"], design: ["ada"] },
  history: [...theirs.history!, step("design", "plan", T("22:47"), 103)],
  handoffs: [
    handoff("define", 102, "merged", T("22:32"), ["bo"]),
    handoff("design", 103, "merged", T("22:47"), ["bo"]),
  ],
} as unknown as ChangeLifecycleInput;

const text = (v: ChangeLifecycleInput) => serializeChange(v as never);

describe("a change's record merged by its fields (ninth UX walk)", () => {
  it("keeps Sync's later state and every hand-off and history entry", () => {
    const r = mergeChangeRecords(base, ours, theirs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe("plan");
    expect(r.value.history.map((h) => h.to)).toEqual(["define", "design", "plan"]);
    expect(r.value.handoffs.map((h) => [h.phase, h.state])).toEqual([
      ["define", "merged"],
      ["design", "merged"],
    ]);
    expect(r.value.authors).toEqual({ brief: ["ada"], proposal: ["ada"], design: ["ada"] });
  });

  it("takes a reviewer's edit of a field this copy didn't touch, and this copy's own", () => {
    const reviewed = { ...theirs, title: "Let tellers lock a card from the branch" };
    const mine = { ...ours, systems: ["cards", "teller"] };
    const r = mergeChangeRecords(base, mine as never, reviewed as never);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.title).toBe("Let tellers lock a card from the branch");
    expect(r.value.systems).toEqual(["cards", "teller"]);
    expect(r.value.state).toBe("plan");
  });

  it("merges owners role by role", () => {
    const reviewed = { ...theirs, owners: { "product-owner": ["ada"], architect: ["ari"] } };
    const mine = { ...ours, owners: { "product-owner": ["ada"], developer: ["dev"] } };
    const r = mergeChangeRecords(base, mine as never, reviewed as never);
    expect(r.ok && r.value.owners).toEqual({
      "product-owner": ["ada"],
      architect: ["ari"],
      developer: ["dev"],
    });
  });

  it("refuses only when both changed the same field differently, naming it", () => {
    const reviewed = { ...theirs, title: "Lock a card at the counter" };
    const mine = { ...ours, title: "Lock a card from the branch" };
    const r = mergeChangeRecords(base, mine as never, reviewed as never);
    expect(r).toEqual({ ok: false, field: "title" });
  });

  it("keeps the further state of a hand-off both sides have, as the host was last read", () => {
    const open = {
      ...ours,
      state: "design",
      history: theirs.history,
      handoffs: [
        handoff("define", 102, "merged", T("22:32"), ["bo"]),
        handoff("design", 103, "open", T("22:40"), ["cy"]),
      ],
    };
    const merged = {
      ...open,
      state: "plan",
      history: ours.history,
      handoffs: [
        handoff("define", 102, "merged", T("22:32"), ["bo"]),
        handoff("design", 103, "merged", T("22:47"), ["bo"]),
      ],
    };
    const r = mergeChangeRecords(base, merged as never, open as never);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const design = r.value.handoffs.find((h) => h.phase === "design")!;
    expect(design.state).toBe("merged");
    expect(design.approvals.map((a) => a.by)).toEqual(["bo"]);
  });

  it("merges the text to canonical YAML, and leaves a record it can't read to the text merge", () => {
    const m = mergeChangeText(text(base), text(ours), text(theirs));
    expect(m).toEqual({ ok: true, text: text(ours) });
    expect(mergeChangeText("state: define\n", "state: design\n", "state: define\n")).toBe(
      undefined,
    );
  });

  it("with no base, merges the lists and refuses a field the two sides disagree on", () => {
    expect(mergeChangeText("", text(ours), text(theirs))).toEqual({ ok: true, text: text(ours) });
    const reviewed = { ...theirs, title: "Lock a card at the counter" };
    expect(mergeChangeText("", text(ours), text(reviewed as never))).toEqual({
      ok: false,
      field: "title",
    });
  });
});
