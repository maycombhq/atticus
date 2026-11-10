import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JOIN_IGNORE_LABEL, JOIN_STEPS, type Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import {
  answerBody,
  IGNORE_LABEL,
  ignoredOf,
  JOIN_STEP_IDS,
  QuestionDetail,
  type AnswerForm,
  type QuestionView,
} from "../src/screens/Questions.js";
import { AnswerBoxChanges, AnswerBoxes } from "../src/screens/map/AnswerBoxes.js";
import { TrustPage } from "../src/screens/map/Trust.js";

/**
 * Beta.24 review: a join question offers Ignore (not a real call), with an optional reason, and
 * says its own words must name a repo or system; Map › Trust lists a box made from an answer's
 * words with its two fixes. On the invented Forge estate.
 */

const C = COPY.questions;
const B = COPY.trust.answerBoxes;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const targets: QuestionView = {
  schemaVersion: 6,
  id: "q-0123456789ab",
  askedBy: {
    step: "facts-targets",
    command: "atticus verify forge-payments --write",
    at: "2026-11-10T12:00:00.000Z",
  },
  repo: "forge-payments",
  question: "Which repo or system answers POST /hooks/outbound, which payments-api calls?",
  options: [
    { label: "forge-accounts", means: "it serves it", changes: "joins it" },
    { label: "None of these", means: "nothing", changes: "a loose end" },
  ],
  evidence: ["src/main/java/forge/payments/HooksClient.java:12"],
  scope: { level: "repo", id: "forge-payments" },
  state: "open",
  rerun: "atticus verify forge-payments --write",
};

const form = (f: Partial<AnswerForm>): AnswerForm => ({
  pick: undefined,
  text: "",
  scope: "repo",
  repoType: "",
  ...f,
});

describe("Ignore on a join question (beta.24 review)", () => {
  it("says the same as the core: its label and the questions it is for", () => {
    expect(IGNORE_LABEL).toBe(JOIN_IGNORE_LABEL);
    expect([...JOIN_STEP_IDS].sort()).toEqual([...JOIN_STEPS].sort());
  });

  it("is offered on a targets question, once, and not on a question of another step", () => {
    const out = html(<QuestionDetail question={targets} onAnswered={() => {}} />);
    expect(out).toContain(esc(IGNORE_LABEL));
    expect(out).toContain(esc(C.ignore.means));
    // On file already (picked before): still one radio.
    const withOption = {
      ...targets,
      options: [...targets.options, { label: IGNORE_LABEL, means: "m", changes: "c" }],
    };
    const twice = html(<QuestionDetail question={withOption} onAnswered={() => {}} />);
    expect(twice.split(esc(IGNORE_LABEL)).length - 1).toBe(1);
    const other = { ...targets, askedBy: { ...targets.askedBy, step: "scan-survey" } };
    expect(html(<QuestionDetail question={other} onAnswered={() => {}} />)).not.toContain(
      esc(IGNORE_LABEL),
    );
  });

  it("posts ignore with its reason, and the scope", () => {
    expect(answerBody(form({ pick: "ignore", reason: " its cicd related " }))).toEqual({
      body: { ignore: true, reason: "its cicd related", scope: "repo" },
    });
    expect(answerBody(form({ pick: "ignore" }))).toEqual({
      body: { ignore: true, scope: "repo" },
    });
  });

  it("says an Ignore answer as ignored by its person, with the reason", () => {
    const answered: QuestionView = {
      ...targets,
      state: "answered",
      answer: {
        text: "Ignore: its cicd related",
        by: "pat",
        at: "2026-11-10T12:00:00.000Z",
        scope: { level: "repo", id: "forge-payments" },
      },
    };
    expect(ignoredOf(answered)).toEqual({ reason: "its cicd related" });
    const out = html(<QuestionDetail question={answered} onAnswered={() => {}} />);
    expect(out).toContain(esc(C.ignore.answered("pat", "2026-11-10", "its cicd related")));
  });

  it("says own words must name a repo or system, on a join question", () => {
    const answered: QuestionView = {
      ...targets,
      state: "answered",
      answer: {
        text: "forge-accounts",
        by: "pat",
        at: "2026-11-10T12:00:00.000Z",
        scope: { level: "repo", id: "forge-payments" },
      },
    };
    expect(html(<QuestionDetail question={answered} onAnswered={() => {}} />)).toContain(
      esc(C.ownWordsJoin),
    );
  });
});

const BOX: Api.AnswerBoxT = {
  id: "ignore-this-its-cicd-related",
  name: "ignore this, its cicd related",
  profile: "org-pack/profiles/forge/profile.yaml",
  questions: [{ id: "q-0123456789ab", repo: "forge-payments", question: targets.question }],
};

describe("a box made from an answer's words on Map › Trust (beta.24 review)", () => {
  it("lists it with where it is and its two fixes, and nothing when there is none", () => {
    expect(html(<AnswerBoxes boxes={[]} />)).toBe("");
    const out = html(<AnswerBoxes boxes={[BOX]} />);
    expect(out).toContain(esc(B.box(BOX.name)));
    expect(out).toContain(esc(B.inProfile(BOX.profile!)));
    expect(out).toContain('href="#/questions/q-0123456789ab"');
    expect(out).toContain(esc(B.ignore));
    expect(out).toContain(esc(B.rename));
    expect(out).toContain(`aria-label="${esc(B.ignoreOf(BOX.name))}"`);
  });

  it("previews what a fix changes: each answer and the profile's lines", () => {
    const out = html(
      <AnswerBoxChanges
        r={{
          id: BOX.id,
          written: false,
          answers: [
            { id: "q-0123456789ab", repo: "forge-payments", was: BOX.name, now: "Ignore: x" },
          ],
          profile: { path: BOX.profile!, changes: [{ was: `  - { id: ${BOX.id} }` }] },
          repos: ["forge-payments"],
        }}
      />,
    );
    expect(out).toContain(esc(B.willIgnore(1)));
    expect(out).toContain(esc(B.answerChange("q-0123456789ab", BOX.name, "Ignore: x")));
    expect(out).toContain(esc(B.profileChange(BOX.profile!)));
  });

  it("is on the Trust page when the view has one", () => {
    const out = html(
      <TrustPage
        of={{
          state: "ready",
          data: { factsDir: "facts", repos: [], problems: [], answerBoxes: [BOX] },
        }}
      />,
    );
    expect(out).toContain(esc(B.box(BOX.name)));
  });
});
