import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { AuditAnswerForm, type AuditSaving, type Pick } from "../src/screens/map/AuditAnswer.js";

/**
 * Map › Trust's Sample audit answered in the app (P3's follow-up, ADR 0149): each item with its
 * cited lines and right, wrong or unsure; a wrong fact offers Correct this and a wrong link the
 * canvas's This link is wrong; the app writes the audit file only, and gives the git command.
 */

const A = COPY.trust.sample;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");

const SAMPLE = Api.AuditSampleView.parse({
  repo: "forge-payments",
  file: "facts/forge-payments.audit.yaml",
  seed: "s1",
  size: 1,
  defaultSeed: "forge-payments@c3c0006",
  command: "atticus verify audit forge-payments --seed s1 --size 1",
  items: [
    {
      id: "fact:entry.post.payments",
      kind: "fact",
      of: "entry",
      claim: "entry POST /payments",
      cites: ["src/main/java/forge/payments/PaymentsController.java:20"],
      fact: "entry.post.payments",
      lines: [
        {
          cite: "src/main/java/forge/payments/PaymentsController.java:20",
          text: '@PostMapping("/payments")',
        },
      ],
    },
    {
      id: "link:call.post.notifications",
      kind: "link",
      of: "joined-by-host",
      claim: "forge-payments POST /notifications → forge-notifications",
      cites: ["forge-payments src/main/java/forge/payments/PaymentsService.java:27"],
      fact: "call.post.notifications",
      to: "forge-notifications",
      answer: "right",
      by: "Priya Nair",
      lines: [{ cite: "forge-payments src/main/java/forge/payments/PaymentsService.java:27" }],
    },
  ],
});

const form = (o: {
  sample?: Parameters<typeof AuditAnswerForm>[0]["sample"];
  picks?: Record<string, Pick>;
  saving?: AuditSaving;
  problem?: string;
}) =>
  html(
    <AuditAnswerForm
      repo="forge-payments"
      sample={o.sample ?? { state: "ready", data: SAMPLE }}
      picks={o.picks ?? {}}
      onPick={() => undefined}
      saving={o.saving ?? { state: "idle" }}
      onSave={() => undefined}
      problem={o.problem}
    />,
  );

describe("answering a sample audit in the app", () => {
  it("has loading, error and refused states", () => {
    expect(form({ sample: { state: "loading" } })).toContain('aria-busy="true"');
    const err = form({ sample: { state: "error", error: "offline" } });
    expect(err).toContain('role="alert"');
    expect(err).toContain(esc(A.failed("offline")));
    const refused = form({
      sample: {
        state: "ready",
        data: {
          ...SAMPLE,
          items: [],
          refused: "unverified",
          unverified: 2,
          command: "atticus verify audit forge-payments",
        },
      },
    });
    expect(refused).toContain(esc(A.refused.unverified!("forge-payments", 2)));
    expect(refused).toContain("atticus verify audit forge-payments");
    expect(form({ sample: { state: "ready", data: { ...SAMPLE, items: [] } } })).toContain(
      esc(A.empty),
    );
  });

  it("shows each item with its lines, labelled choices and the answer on file", () => {
    const out = form({});
    expect(out).toContain(esc(A.item(1, 2, A.fact, "entry POST /payments")));
    expect(out).toContain(esc(A.item(2, 2, A.link("joined-by-host"), SAMPLE.items[1]!.claim)));
    expect(out).toContain(esc('@PostMapping("/payments")'));
    expect(out).toContain(esc(A.noText));
    expect(out).toContain("<fieldset");
    expect(out).toContain("<legend>");
    expect((out.match(/type="radio"/g) ?? []).length).toBe(6);
    expect(out).toContain(esc(A.onFile("Right", "Priya Nair")));
    // The answer on file is the chosen one.
    expect(out).toContain(`checked="" value="right"`);
    expect(out).toContain(esc(SAMPLE.command));
  });

  it("offers Correct this for a fact answered wrong, and the canvas for a wrong link", () => {
    const out = form({
      picks: {
        "fact:entry.post.payments": { answer: "wrong", note: "It is a PUT" },
        "link:call.post.notifications": { answer: "wrong", note: "" },
      },
    });
    expect(out).toContain(esc(A.note));
    expect(out).toContain(`aria-label="${esc(A.wrongFactOf("entry POST /payments"))}"`);
    expect(out).toContain(esc(A.wrongLink("forge-payments")));
    expect(out).toContain('href="#/canvas?lens=repo&amp;node=repo%3Aforge-payments"');
  });

  it("says it is writing, an error, and once written the file and the git command", () => {
    expect(form({ saving: { state: "working" } })).toContain(esc(A.saving));
    expect(form({ saving: { state: "error", text: "Not in this sample" } })).toContain(
      "Not in this sample",
    );
    expect(form({ problem: A.nothingPicked })).toContain(esc(A.nothingPicked));
    const done = form({
      saving: {
        state: "done",
        result: {
          file: "facts/forge-payments.audit.yaml",
          answered: 2,
          open: 0,
          items: [],
          precision: {
            facts: {
              drawn: 1,
              right: 0,
              wrong: 1,
              unsure: 0,
              open: 0,
              gone: 0,
              precision: 0,
              low: 0,
              high: 0.79,
            },
            links: {
              drawn: 1,
              right: 1,
              wrong: 0,
              unsure: 0,
              open: 0,
              gone: 0,
              precision: 1,
              low: 0.21,
              high: 1,
            },
          },
          commit: 'git add facts/forge-payments.audit.yaml && git commit -m "x"',
        },
      },
    });
    expect(done).toContain(esc(A.saved("facts/forge-payments.audit.yaml", 2, 0)));
    expect(done).toContain("git add facts/forge-payments.audit.yaml");
  });
});
