import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api, Finding } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import {
  acceptedNote,
  acceptPreview,
  AcceptForm,
  FindingCardInThread,
  StageThreadView,
  withoutAccepted,
} from "../src/screens/work/StageThread.js";

/**
 * ADR 0203 A, the app's half: the stage's thread shows the stage's own blocking findings apart
 * from the critic's; an accepted one is listed apart from the open ones, with who and why; an
 * acceptable open one has Accept, which asks who (the person the app records, never typed) and
 * why (required), previews what accepting does, and writes through the command line's waive; one
 * that can't be accepted says why in the copy file's words, leading with what to do; an
 * assistant's app offers no Accept. The form has its empty, loading, error and refused states.
 * Accessibility: every field has its label, hints are described-by, errors are alerts; the
 * journey (41-accept-a-finding) runs axe on the same states in a browser.
 */

const A = COPY.accept;
const T = COPY.thread;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const CHANGE = "add-transfer-limit";
const REL = `openspec/changes/${CHANGE}`;

const stageFinding = (id: string, rule: string, summary: string, o: Partial<Finding> = {}) =>
  ({
    schemaVersion: 1,
    id,
    kind: "issue",
    change: CHANGE,
    gate: "stage-feature",
    round: 2,
    rule,
    layer: "org",
    lens: "true",
    severity: "blocking",
    artifact: "feature.yaml",
    locator: { heading: "feature" },
    summary,
    why: summary,
    fix: { text: `Fix feature.yaml and run atticus change feature ${CHANGE} again.` },
    evidence: [{ source: "artifact", path: "feature.yaml" }],
    waivable: true,
    state: "open",
    createdAt: "2026-11-22T09:00:00Z",
    ...o,
  }) as unknown as Finding;

type FindingItem = Extract<Api.ThreadItemT, { kind: "finding" }>;
const item = (
  f: Finding,
  view: Partial<FindingItem["view"]> = {},
  at = "2026-11-22T09:00:00Z",
): FindingItem => ({
  kind: "finding",
  at,
  view: {
    finding: f,
    file: `${REL}/review/stage-feature/2/${f.id}.yaml`,
    options: { fix: f.fix.text, apply: false, dismiss: false, waive: f.state === "open" },
    comments: [],
    ...view,
  },
  assistantWrites: true,
});

const REPO = stageFinding(
  "stage-545a12e674d8",
  "feature.unknown-repo",
  'New flow "Check the daily transfer limit" is put in repo forge-limits, which the estate doesn\'t have.',
);
const ARCHIVED = stageFinding(
  "stage-0a0a0a0a0a0a",
  "feature.archived-repo",
  'New flow "Keep the old limits" is put in repo forge-legacy-limits, which the manifest marks archived.',
  { waivable: false },
);
const ACCEPTED = stageFinding(
  "stage-b1b1b1b1b1b1",
  "feature.unknown-repo",
  'New flow "Reset the limits" is put in repo forge-reset, which the estate doesn\'t have.',
  {
    state: "waived",
    resolution: {
      action: "waive",
      by: "pat",
      at: "2026-11-22T08:00:00Z",
      reason: "forge-reset is created in this release.",
    },
  } as Partial<Finding>,
);

const VIEW: Api.StageThreadViewT = {
  change: CHANGE,
  stage: "feature",
  state: "stopped",
  headline: "The stage stopped.",
  items: [
    item(REPO, { accept: { can: true, as: "priya" } }, "2026-11-22T09:01:00Z"),
    item(ARCHIVED, { accept: { can: false, why: "archived-repo", as: "priya" } }),
    item(ACCEPTED, {
      accepted: {
        by: "pat",
        why: "forge-reset is created in this release.",
        at: "2026-11-22T08:00:00Z",
      },
    }),
  ],
  step: ["change", "feature", CHANGE],
  reply: { open: true },
  problems: [],
};

const page = (v: Partial<Api.StageThreadViewT> = {}) =>
  renderToStaticMarkup(
    <StageThreadView of={{ state: "ready", data: { ...VIEW, ...v } }} stage="feature" />,
  );

const form = (o: Parameters<typeof AcceptForm>[0]["initial"] = {}, others = 0, waiting = false) =>
  renderToStaticMarkup(
    <AcceptForm
      it={item(REPO, { accept: { can: true, as: "priya" } })}
      stage="feature"
      command={`atticus change feature ${CHANGE}`}
      others={others}
      waiting={waiting}
      onCancel={() => undefined}
      initial={o}
    />,
  );

describe("the stage's thread: the stage's own findings", () => {
  it("names them as the stage's checks', not the critic's", () => {
    const h = page();
    expect(h).toContain(`aria-label="${esc(A.stageFinding)}: ${REPO.id}"`);
    expect(h).not.toContain(`aria-label="${esc(T.finding)}: ${REPO.id}"`);
  });

  it("lists an accepted finding apart from the open ones, with who and why", () => {
    const h = page();
    // A region of its own, named by its heading.
    const heading = new RegExp(
      `<h3 id="([^"]+)"[^>]*>${esc(A.acceptedTitle("feature")).replace(/[()]/g, "\\$&")}</h3>`,
    ).exec(h);
    expect(heading).not.toBeNull();
    expect(h).toContain(`aria-labelledby="${heading![1]}"`);
    expect(h).toContain(esc(A.acceptedBy("pat", "forge-reset is created in this release.")));
    // Who and why, as the stage's files say it: "accepted by pat: <why>".
    expect(A.acceptedBy("pat", "forge-reset is created in this release.")).toBe(
      "Accepted by pat: forge-reset is created in this release.",
    );
    // Not in the conversation's list: the open ones are, the accepted one is apart, after it.
    const list = h.slice(h.indexOf('<ol class="thread"'), h.indexOf("</ol>"));
    expect(list).toContain(REPO.id);
    expect(list).not.toContain(ACCEPTED.id);
    expect(h.indexOf(ACCEPTED.id)).toBeGreaterThan(h.indexOf("</ol>"));
    // No Undo: there is none on the command line either, and the words say so.
    expect(h).toContain(esc(A.noUndo));
    // An accepted finding has no Accept.
    expect(h).not.toContain(`aria-label="${esc(A.acceptFor(ACCEPTED.id))}"`);
  });

  it("says who and why once: the stage's own words of the acceptance are left off its summary", () => {
    const said =
      'New flow "Reset the limits" is put in repo forge-reset, which the estate doesn\'t have. (accepted by pat: forge-reset is created in this release.)';
    expect(withoutAccepted(said)).toBe(
      'New flow "Reset the limits" is put in repo forge-reset, which the estate doesn\'t have.',
    );
    const h = page({
      items: [
        item({ ...ACCEPTED, summary: said } as Finding, {
          accepted: {
            by: "pat",
            why: "forge-reset is created in this release.",
            at: "2026-11-22T08:00:00Z",
          },
        }),
      ],
    });
    expect(h.match(/forge-reset is created in this release/g)).toHaveLength(1);
  });

  it("an open acceptable finding has Accept; one that can't be accepted says why, leading with what to do", () => {
    const h = page();
    expect(h).toContain(`aria-label="${esc(A.acceptFor(REPO.id))}"`);
    expect(h).not.toContain(`aria-label="${esc(A.acceptFor(ARCHIVED.id))}"`);
    expect(h).toContain(esc(A.cant["archived-repo"]!));
    expect(A.cant["archived-repo"]).toMatch(/^Put the work in the repo that took over/);
    // Not relevant isn't offered for a stage's finding: its next run raises it again.
    expect(h).not.toContain(esc(T.notRelevant));
  });

  it("has words for every reason a finding can't be accepted, each leading with what to do", () => {
    const kinds = [
      "constitution",
      "assistant",
      "assistant-session",
      "document-over-code",
      "nothing-to-plan",
      "needs-catalog",
      "contradicts-fact",
      "data-safety",
      "archived-repo",
      "cites-missing-code",
      "order",
      "answer-shape",
      "next-stage-needs",
    ] as const;
    for (const k of kinds) {
      const words = A.cant[k];
      expect(words, k).toBeTruthy();
      expect(words, k).not.toMatch(/^(It|This|The|You can't|Can't)\b/);
      expect(words, k).not.toMatch(/\bwaive/i);
    }
    expect(A.cantAssistant("claude-code")).toMatch(/^Ask a person to accept it/);
  });

  it("an assistant's app offers no Accept, and says a person accepts", () => {
    const h = page({
      items: [item(REPO, { accept: { can: false, why: "assistant", as: "claude-code" } })],
    });
    expect(h).not.toContain(`aria-label="${esc(A.acceptFor(REPO.id))}"`);
    expect(h).toContain(esc(A.cantAssistant("claude-code")));
    const session = page({
      items: [item(REPO, { accept: { can: false, why: "assistant-session", as: "priya" } })],
    });
    expect(session).not.toContain(`aria-label="${esc(A.acceptFor(REPO.id))}"`);
    expect(session).toContain(esc(A.cant["assistant-session"]!));
  });

  it("an older server that sends no accept shows no Accept", () => {
    const h = page({ items: [item(REPO)] });
    expect(h).not.toContain(`aria-label="${esc(A.acceptFor(REPO.id))}"`);
  });
});

describe("the Accept form", () => {
  it("asks who (the person the app records, not typed) and why (required), each labelled", () => {
    const h = form();
    expect(h).toContain(esc(A.title(REPO.rule)));
    expect(h).toContain(esc(A.who));
    expect(h).toContain(esc(A.whoIs("priya")));
    // Who is shown, never a field: the app records the person using it.
    expect(h.match(/<input/g)).toBeNull();
    const id = /<textarea[^>]*id="([^"]+)"/.exec(h)?.[1];
    expect(id).toBeDefined();
    expect(h).toContain(`for="${id}"`);
    expect(h).toContain(esc(A.reason));
    expect(h).toMatch(/<textarea[^>]*required=""/);
    expect(h).toMatch(/<textarea[^>]*aria-required="true"/);
    const described = /<textarea[^>]*aria-describedby="([^"]+)"/.exec(h)?.[1] ?? "";
    for (const d of described.split(" ")) expect(h).toContain(`id="${d}"`);
    expect(h).toContain(`>${esc(A.submit)}<`);
    expect(h).toContain(`>${esc(A.cancel)}<`);
  });

  it("previews what accepting does before anything is written", () => {
    const h = form();
    expect(h).toContain(esc(A.preview));
    for (const line of acceptPreview({
      stage: "feature",
      rule: REPO.rule,
      file: `${REL}/review/stage-feature/2/${REPO.id}.yaml`,
      others: 0,
      waiting: false,
      command: `atticus change feature ${CHANGE}`,
    }))
      expect(h).toContain(esc(line));
  });

  it("preview: the stage can end done, and the later stages carry the acceptance", () => {
    const base = {
      stage: "feature",
      rule: "feature.unknown-repo",
      file: `${REL}/review/stage-feature/2/x.yaml`,
      command: `atticus change feature ${CHANGE}`,
    };
    const rerun = acceptPreview({ ...base, others: 0, waiting: false });
    expect(rerun).toEqual([
      A.previewRecord(base.file),
      A.previewDone("feature", base.command),
      A.carries["feature.unknown-repo"],
    ]);
    expect(A.previewDone("feature", base.command)).toContain(base.command);
    expect(acceptPreview({ ...base, others: 0, waiting: true })[1]).toBe(
      A.previewWaiting("feature"),
    );
    expect(acceptPreview({ ...base, others: 2, waiting: false })[1]).toBe(
      A.previewOthers("feature", 2),
    );
    // A rule with no words of its own still says the later stages carry it.
    expect(acceptPreview({ ...base, rule: "x.y", others: 0, waiting: false })[2]).toBe(
      A.carriesDefault,
    );
    for (const words of Object.values(A.carries)) expect(words).not.toMatch(/\bwaive/i);
  });

  it("empty: Accept without a reason says to write one, as an alert, and writes nothing", () => {
    const h = form({ state: "invalid" });
    expect(h).toContain(esc(A.needReason));
    expect(h).toMatch(/role="alert"[^>]*>[^<]*/);
    expect(h).toMatch(/<textarea[^>]*aria-invalid="true"/);
  });

  it("loading: the button says it is accepting, and can't be pressed twice", () => {
    const h = form({ state: "busy", reason: "It is created in this release" });
    expect(h).toContain(`>${esc(A.busy)}<`);
    expect(h).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    expect(h).toContain('aria-busy="true"');
  });

  it("error: the server's words, as an alert, with the reason kept to send again", () => {
    const h = form({
      state: "error",
      reason: "It is created in this release",
      error: "The server is gone.",
    });
    expect(h).toContain("The server is gone.");
    expect(h).toMatch(/role="alert"/);
    expect(h).toContain("It is created in this release</textarea>");
    expect(h).not.toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });

  it("refused: the command line's refusal, as an alert, and no Accept to press again", () => {
    const words =
      "stage-545a12e674d8 comes from a constitution rule (constitution.x), which can never be waived or accepted (rule 6). Fix it.";
    const h = form({ state: "refused", reason: "x", error: words });
    expect(h).toContain(esc(words));
    expect(h).toMatch(/role="alert"/);
    expect(h).not.toContain(`>${esc(A.submit)}<`);
    expect(h).toContain(`>${esc(A.close)}<`);
  });
});

describe("after an Accept: what the app did with the stage (ADR 0203 A, addendum 2026-11-22)", () => {
  const ID = REPO.id;
  it("says it went on, in the copy file's words, for each thing the server did", () => {
    expect(acceptedNote(ID, "feature", { kind: "done" })).toBe(A.went.done("feature"));
    expect(A.went.done("feature")).toBe(
      "Accepted. The app went on with the feature stage, and it is done.",
    );
    for (const kind of ["questions", "stopped", "drafting", "waiting", "failed"] as const)
      expect(acceptedNote(ID, "feature", { kind, runId: "run-1" })).toBe(A.went[kind]("feature"));
    // Every one starts as an acceptance does, and none names a command to type.
    for (const words of [
      ...(["done", "questions", "stopped", "drafting", "waiting", "failed"] as const).map((k) =>
        A.went[k]("feature"),
      ),
      A.went.held("feature", 1),
      A.went.held("feature", 2),
      A.went.notResumed("feature"),
    ]) {
      expect(words).toMatch(/^Accepted[.,]/);
      expect(words).not.toMatch(/atticus /);
    }
  });

  it("when it can't go on, says exactly what to press", () => {
    expect(acceptedNote(ID, "feature", { kind: "held", held: 1 })).toBe(A.went.held("feature", 1));
    expect(A.went.held("feature", 1)).toContain(T.startNext);
    expect(A.went.held("feature", 2)).toMatch(/2 more findings or questions/);
    const why = "The step wasn't prepared.";
    expect(acceptedNote(ID, "feature", { kind: "not-resumed", lines: [why] })).toBe(
      A.went.notResumed("feature", why),
    );
    expect(A.went.notResumed("feature", why)).toContain(why);
    expect(A.went.notResumed("feature")).toContain(T.startNext);
  });

  it("an older server that says nothing of it: the acceptance alone", () => {
    expect(acceptedNote(ID, "feature", undefined)).toBe(A.done(ID, "feature"));
  });

  it("the preview says the app goes on at once, so nothing is left to type", () => {
    expect(A.previewDone("feature", `atticus change feature ${CHANGE}`)).toMatch(
      /^Nothing else blocks the feature stage: the app runs it again as soon as you accept it/,
    );
    expect(A.previewWaiting("feature")).toMatch(
      /^Nothing else blocks the feature stage: the app goes on with it as soon as you accept it/,
    );
  });
});

describe("said once, and no Accept that would be refused again (the review of 3aa297bd)", () => {
  const count = (h: string, words: string) => h.split(esc(words)).length - 1;
  const card = (initial?: { refused?: string }) =>
    renderToStaticMarkup(
      <FindingCardInThread
        it={item(REPO, { accept: { can: true, as: "priya" } })}
        change={CHANGE}
        onReplyTo={() => undefined}
        onFixToAssistant={() => undefined}
        reason=""
        accept={{
          stage: "feature",
          command: `atticus change feature ${CHANGE}`,
          others: 0,
          waiting: false,
        }}
        {...(initial ? { initial } : {})}
      />,
    );

  it("after a refusal (403), the card offers no Accept to press again, and keeps the refusal's words", () => {
    expect(card()).toContain(`aria-label="${esc(A.acceptFor(REPO.id))}"`);
    const words = "Recorded as claude-code: CLAUDECODE is set. claude-code is an assistant.";
    const h = card({ refused: words });
    expect(h).not.toContain(`aria-label="${esc(A.acceptFor(REPO.id))}"`);
    expect(h).toContain(esc(A.refused(words)));
  });

  it("the accept note is the one thing announced: the headline isn't a live region beside it", () => {
    const note = A.went.done("feature");
    const h = renderToStaticMarkup(
      <StageThreadView of={{ state: "ready", data: VIEW }} stage="feature" initialNote={note} />,
    );
    expect(h.match(/role="status"/g)).toHaveLength(1);
    expect(h).toMatch(new RegExp(`role="status"[^>]*>${esc(note).replace(/[.()]/g, "\\$&")}<`));
    // With no note, the headline is the stage's live status, as before.
    expect(page()).toMatch(/role="status" aria-live="polite" class="thread-headline"/);
  });

  it("no Undo is said once: by the accepted list when there is one, else by the form", () => {
    expect(count(page(), A.noUndo)).toBe(1);
    expect(count(form(), A.noUndo)).toBe(1);
    const shown = renderToStaticMarkup(
      <AcceptForm
        it={item(REPO, { accept: { can: true, as: "priya" } })}
        stage="feature"
        command={`atticus change feature ${CHANGE}`}
        others={0}
        waiting={false}
        noUndoShown
        onCancel={() => undefined}
      />,
    );
    expect(count(shown, A.noUndo)).toBe(0);
  });
});

describe("a critic's finding where an assistant works (the review of b30/review2-fixes)", () => {
  const critic = stageFinding("f-plan-1", "ledger.limits-named", "No limit is named.", {
    gate: "plan",
    artifact: "proposal.md",
  });
  const card = (view: Partial<FindingItem["view"]>) =>
    renderToStaticMarkup(
      <FindingCardInThread
        it={{ ...item(critic, view), assistantWrites: false }}
        change={CHANGE}
        onReplyTo={() => undefined}
        onFixToAssistant={() => undefined}
        reason=""
        accept={{
          stage: "feature",
          command: `atticus change feature ${CHANGE}`,
          others: 0,
          waiting: false,
        }}
      />,
    );

  it("offers no Not relevant there, and says why in the copy file's words", () => {
    const options = { fix: critic.fix.text, apply: false, dismiss: false, waive: false };
    const h = card({
      options,
      personOnly: { why: "assistant-terminal", because: "CLAUDECODE is set" },
    });
    expect(h).toContain(esc(T.personOnly("assistant-terminal", "CLAUDECODE is set")));
    expect(h).not.toContain(`>${esc(T.notRelevant)}<`);
    const acp = card({ options, personOnly: { why: "assistant-session" } });
    expect(acp).toContain(esc(T.personOnly("assistant-session")));
    // In a person's own app: Not relevant, and no such words.
    const own = card({ options: { ...options, dismiss: true } });
    expect(own).toContain(`>${esc(T.notRelevant)}<`);
    expect(own).not.toContain(esc(T.personOnly("assistant-session")));
  });
});
