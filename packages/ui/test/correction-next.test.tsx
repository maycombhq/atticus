import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { CorrectionNextPanel } from "../src/app/correction-next.js";
import { COPY } from "../src/copy.js";

/**
 * Corrections without git commands (plan item C4, ADR 0149): after a correction the app writes,
 * one panel says the app wrote only the correction file, shows its line as written, the commands
 * to run in order (each with a copy button), and what the next verify --write will change.
 */

const N = COPY.correctionNext;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
const FILE = "facts/forge-payments.corrections.jsonl";
const LINE = '{"schemaVersion":1,"fact":"call.post.debits","action":"edit"}';
const BRANCH = "correct/forge-payments-call.post.debits";

const VIEW = Api.VerifyPreviewView.parse({
  repo: "forge-payments",
  wrote: FILE,
  branch: BRANCH,
  steps: [
    { step: "verify", command: "atticus verify forge-payments --write" },
    { step: "branch", command: `git switch -c ${BRANCH}` },
    { step: "add", command: `git add ${FILE} facts/forge-payments.jsonl` },
    { step: "commit", command: 'git commit -m "forge-payments: x"' },
    { step: "push", command: `git push -u origin ${BRANCH}` },
    { step: "pr" },
  ],
  preview: {
    facts: {
      dropped: [
        { id: "call.post.notify", kind: "call", label: "POST /notifications", why: "wrong" },
      ],
      edited: [
        {
          id: "call.post.debits",
          kind: "call",
          label: "POST /accounts/{id}/debits → cards-api",
          fields: [{ name: "to", now: "cards-api" }],
        },
      ],
      kept: 8,
    },
    catalog: { added: 1, changed: 0, removed: 0, evidenceOnly: 1, files: [] },
    links: {
      added: [],
      removed: [],
      changed: [],
      unmade: [
        {
          id: "if-1",
          from: "payments-api",
          to: "notify-api",
          method: "POST",
          path: "/notifications",
          confidence: "inferred",
        },
      ],
      moved: [
        {
          from: "payments-api",
          method: "POST",
          path: "/accounts/{}/debits",
          was: "accounts-api",
          to: "cards-api",
        },
      ],
    },
    staleCorrections: [],
  },
});

const panel = (preview: Parameters<typeof CorrectionNextPanel>[0]["preview"]) =>
  html(<CorrectionNextPanel file={FILE} line={LINE} preview={preview} />);

describe("what happens after a correction (C4)", () => {
  it("says the app wrote only the correction file and shows its line as written", () => {
    const out = panel({ state: "loading" });
    expect(out).toContain(esc(N.onlyWrote(FILE)));
    expect(out).toContain(esc(N.fileDiff(FILE)));
    expect(out).toContain(esc(`+ ${LINE}`));
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain(esc(N.loading));
  });

  it("says an error, and why there is no preview, with the commands still given", () => {
    expect(panel({ state: "error", error: "offline" })).toContain(esc(N.failed("offline")));
    expect(panel({ state: "error", error: "offline" })).toContain('role="alert"');
    const none = panel({
      state: "ready",
      data: { ...VIEW, preview: undefined, unavailable: "no-checkout" },
    });
    expect(none).toContain(esc(N.unavailable["no-checkout"]!));
    expect(none).toContain("atticus verify forge-payments --write");
  });

  it("lists the commands in order, each with a labelled copy button, and the pull request by hand", () => {
    const out = panel({ state: "ready", data: VIEW });
    const at = (s: string) => out.indexOf(esc(s));
    const order = VIEW.steps.filter((s) => s.command).map((s) => at(s.command!));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out).toContain("<ol");
    for (const s of VIEW.steps.filter((x) => x.command))
      expect(out).toContain(`aria-label="${esc(N.copy(`${N.step[s.step]}: ${s.command}`))}"`);
    expect(out).toContain(esc(N.prByHand(BRANCH)));
  });

  it("shows what the write will change: facts dropped and edited, links moved and unmade, the catalog", () => {
    const out = panel({ state: "ready", data: VIEW });
    expect(out).toContain(esc(N.previewTitle));
    expect(out).toContain(esc(`${N.dropped}: POST /notifications (${N.droppedWhy.wrong})`));
    expect(out).toContain(esc(N.field("to", undefined, "cards-api")));
    expect(out).toContain(
      esc(
        N.moved(
          N.linkWhat("payments-api", "accounts-api", "POST", "/accounts/{}/debits"),
          "accounts-api",
          "cards-api",
        ),
      ),
    );
    expect(out).toContain(
      esc(N.unmade(N.linkWhat("payments-api", "notify-api", "POST", "/notifications"))),
    );
    expect(out).toContain(esc(N.catalog(1, 0, 0, 1)));
    expect(out).toContain(esc(N.kept(8)));
  });

  it("says the write puts nothing in the catalog while facts are rejected", () => {
    const out = panel({
      state: "ready",
      data: {
        ...VIEW,
        preview: {
          ...VIEW.preview!,
          blocked: { rejected: 2 },
          headMoved: { head: "abcdef123456", commit: "c3c0006" },
        },
      },
    });
    expect(out).toContain(esc(N.blocked(2)));
    expect(out).toContain(esc(N.headMoved("abcdef123456", "c3c0006")));
  });

  it("says when the Apply will wait for a confirm of its removals, with the command (G1)", () => {
    const cmd = "atticus verify forge-payments --write --allow-removals 6";
    expect(panel({ state: "ready", data: VIEW })).not.toContain(esc(N.confirm(6)));
    const out = panel({
      state: "ready",
      data: { ...VIEW, preview: { ...VIEW.preview!, confirm: { removals: 6, command: cmd } } },
    });
    expect(out).toContain(esc(N.confirm(6)));
    expect(out).toContain('role="status"');
    expect(out).toContain(`aria-label="${esc(N.copy(`${N.confirmCommand}: ${cmd}`))}"`);
  });
});
