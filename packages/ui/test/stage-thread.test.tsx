import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api, Finding } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { StageThreadView } from "../src/screens/work/StageThread.js";
import { lensesWaiting } from "../src/screens/work/critic-ran.js";
import { strokeOf, EMPTY_FORM } from "../src/screens/work/Sketch.js";

/**
 * ADR 0188: a stage is one conversation. The stage's tab shows its thread inline: the prompt
 * with Copy, the answer and its checks, the critic's findings with Reply and Make the fix, the
 * questions, the dropped question with Keep it anyway, and the reply box; no sizes, models or
 * paths outside Details.
 */

const T = COPY.thread;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const CHANGE = "add-transfer-limit";

const finding = {
  schemaVersion: 1,
  id: "f-0000000a",
  kind: "issue",
  change: CHANGE,
  gate: "design",
  round: 1,
  rule: "constitution.interface-ends-in-catalog",
  layer: "constitution",
  lens: "true",
  severity: "blocking",
  artifact: "interfaces.md",
  locator: { line: 7 },
  summary: "The callee forge-x of POST /x is not in the catalog.",
  why: "w",
  fix: { text: "Correct the name." },
  evidence: [],
  waivable: false,
  state: "open",
  createdAt: "2026-11-09T09:06:00Z",
} as unknown as Finding;

const VIEW: Api.StageThreadViewT = {
  change: CHANGE,
  stage: "architecture",
  state: "waiting",
  headline: "The prompt below waits for your assistant.",
  items: [
    {
      kind: "prompt",
      at: "2026-11-09T09:00:00Z",
      runId: "run-1",
      who: "drafter",
      prompt: "# flow-architect: write architecture-answer.yaml\n\nWrite it.",
      state: "validated",
      details: {
        agent: "flow-architect",
        runtime: "hand-off",
        promptPath: ".runs/x/run-1/prompt.md",
        promptTokens: 4210,
        attempt: 1,
      },
    },
    {
      kind: "answer",
      at: "2026-11-09T09:01:00Z",
      runId: "run-1",
      who: "drafter",
      checked: "passed",
      by: "app",
      summary: ["flows: 2"],
      problems: [],
    },
    {
      kind: "finding",
      at: "2026-11-09T09:06:00Z",
      view: {
        finding,
        file: `openspec/changes/${CHANGE}/review/design/1/f-0000000a.yaml`,
        options: { fix: "Correct the name.", apply: true, dismiss: true, waive: false },
        comments: [],
      },
      assistantWrites: false,
      edit: { artifact: "interfaces", line: 7 },
    },
    {
      kind: "dropped",
      at: "2026-11-09T09:07:00Z",
      key: "0123456789ab",
      question: "Does a refusal notify the owner?",
      evidence: [`openspec/changes/${CHANGE}/brief.md:31`],
      nearest: `openspec/changes/${CHANGE}/brief.md:29`,
    },
    {
      kind: "reply",
      at: "2026-11-09T09:08:00Z",
      text: "Keep the scheduler new.",
      by: "Priya Nair",
      read: false,
    },
    {
      kind: "prompt",
      at: "2026-11-09T09:10:00Z",
      runId: "run-2",
      who: "drafter",
      prompt: "# flow-architect: write architecture-answer.yaml",
      state: "waiting",
      details: { agent: "flow-architect", runtime: "hand-off", promptPath: "p", attempt: 2 },
    },
  ],
  waiting: { runId: "run-2", prompt: "x" },
  step: ["change", "architecture", CHANGE],
  reply: { open: true },
  problems: [],
};

const page = (v: Partial<Api.StageThreadViewT> = {}) =>
  renderToStaticMarkup(
    <StageThreadView of={{ state: "ready", data: { ...VIEW, ...v } }} stage="architecture" />,
  );

describe("the stage's thread", () => {
  it("shows the prompt with Copy, the answer the app checked, the finding with its buttons, in order", () => {
    const h = page();
    expect(h).toContain(esc(T.title("architecture")));
    expect(h).toContain('role="status"');
    expect(h).toContain(esc(VIEW.headline));
    expect(h).toContain(`aria-label="${esc(T.copyPromptFor("run-1"))}`);
    expect(h).toContain(esc(T.checked.passed!));
    expect(h).toContain(esc(T.checkedBy.app!));
    expect(h).toContain(`aria-label="${esc(T.replyFor("f-0000000a"))}"`);
    expect(h).toContain(`aria-label="${esc(T.makeFixFor("f-0000000a"))}"`);
    expect(h.indexOf(esc(T.answer))).toBeLessThan(h.indexOf(esc(finding.summary)));
    // The waiting prompt says what to do with it; the round's start waits for the answer.
    expect(h).toContain(esc(T.pasteHint));
    expect(h).not.toContain(esc(T.startNext));
  });

  it("keeps a prompt's size, model and files under Details", () => {
    const h = page();
    const details = h.indexOf(`<summary>${esc(T.details)}</summary>`);
    expect(details).toBeGreaterThan(0);
    expect(h.indexOf(esc(T.detailTokens(4210)))).toBeGreaterThan(details);
    expect(h.indexOf(".runs/x/run-1/prompt.md")).toBeGreaterThan(details);
  });

  it("shows a question that couldn't be kept, with Keep it anyway, never dropped", () => {
    const h = page();
    expect(h).toContain(esc(T.dropped));
    expect(h).toContain(esc(T.droppedNearest(`openspec/changes/${CHANGE}/brief.md:29`)));
    expect(h).toContain(`aria-label="${esc(T.keepFor("Does a refusal notify the owner?"))}"`);
  });

  it("has the reply box at the bottom, Send only while a prompt waits, Send and start the next round after", () => {
    const h = page();
    expect(h).toContain(esc(T.replyLabel));
    expect(h).toContain(`>${esc(T.sendOnly)}<`);
    expect(h.lastIndexOf(esc(T.replyLabel))).toBeGreaterThan(
      h.indexOf(esc("Keep the scheduler new.")),
    );
    const after = page({ state: "drafting", waiting: undefined });
    expect(after).toContain(`>${esc(T.send)}<`);
    expect(after).toContain(`>${esc(T.startNext)}<`);
  });

  it("has loading, error, empty and not-yet states", () => {
    expect(
      renderToStaticMarkup(<StageThreadView of={{ state: "loading" }} stage="feature" />),
    ).toContain('aria-busy="true"');
    expect(
      renderToStaticMarkup(
        <StageThreadView
          of={{ state: "error", error: new Error("boom"), reload: () => undefined } as never}
          stage="feature"
        />,
      ),
    ).toContain("boom");
    const none = page({
      state: "not-started",
      items: [],
      waiting: undefined,
      reply: { open: false, why: "Start it first." },
    });
    expect(none).toContain(esc(T.empty));
    expect(none).toContain(`>${esc(T.start)}<`);
    expect(none).toContain("Start it first.");
  });
});

describe("the critic's note says a lens waits only when one does", () => {
  it("counts the round's lenses waiting with a run", () => {
    expect(lensesWaiting(undefined)).toBe(0);
    expect(lensesWaiting({ round: { lenses: [{ lens: "true", state: "skipped" }] } })).toBe(0);
    expect(
      lensesWaiting({ round: { lenses: [{ lens: "true", state: "waiting", runId: "run-1" }] } }),
    ).toBe(1);
    expect(T.criticRan(0)).toBe("The rule checks ran.");
    expect(T.criticRan(1)).toMatch(/an AI lens waits for your assistant in the stage's thread/);
  });
});

describe("the retire stroke", () => {
  it("says the component and why", () => {
    expect(strokeOf({ ...EMPTY_FORM, kind: "retire" })).toEqual({
      missing: COPY.sketch.missing.component,
    });
    expect(
      strokeOf({ ...EMPTY_FORM, kind: "retire", component: "forge-legacy", why: "Replaced" }),
    ).toEqual({ stroke: { kind: "retire", component: "forge-legacy", why: "Replaced" } });
  });
});
