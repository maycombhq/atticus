import { describe, expect, it } from "vitest";
import { TOPICS_STEP_ID, topicQuestionText, type Question } from "@maycombhq/core";
import { staleTopicQuestions } from "../src/index.js";

/**
 * Review round 49 (end to end): a topic owner question (ADR 0162, F8: no repo of the estate
 * serves the other side of the topic) retires once the topic is no longer a loose end, the other
 * side read and joined; one whose topic is asked again under another id (its line moved) names
 * that question. An answered question, or another repo's or step's, is never retired.
 */
const REPO = "forge-cards";
const question = (
  id: string,
  topic: string,
  o: { state?: "open" | "answered"; step?: string; repo?: string } = {},
): Question =>
  ({
    schemaVersion: 2,
    id,
    askedBy: {
      step: o.step ?? TOPICS_STEP_ID,
      command: "atticus verify forge-cards --write",
      at: "2026-11-01T10:00:00.000Z",
    },
    repo: o.repo ?? REPO,
    question: topicQuestionText(topic, REPO, "listen"),
    options: [
      { label: "Another team's system or a vendor", means: "m", changes: "c" },
      { label: "None of these", means: "m", changes: "c" },
    ],
    evidence: ["src/main/java/forge/cards/AuditListener.java:9"],
    scope: { level: "repo", id: o.repo ?? REPO },
    state: o.state ?? "open",
    rerun: "atticus verify forge-cards --write",
    ...(o.state === "answered"
      ? {
          answer: {
            option: 2,
            by: "dana.okafor",
            at: "2026-11-01T11:00:00.000Z",
            scope: { level: "repo", id: REPO },
          },
        }
      : {}),
  }) as Question;

describe("staleTopicQuestions", () => {
  it("retires an open topic question once its topic is no longer unresolved", () => {
    const q = question("q-111111111111", "harbor.audit.events");
    expect(staleTopicQuestions({ repo: REPO, open: [q], drafted: [] })).toEqual([
      {
        id: "q-111111111111",
        why: "harbor.audit.events is no longer a loose end: a repo of the estate serves its other side now, or the profile names who owns it",
      },
    ]);
  });

  it("names the question that asks about the topic now, and keeps one still asked", () => {
    const old = question("q-111111111111", "harbor.audit.events");
    const kept = question("q-222222222222", "lantern.mail.outbox");
    const out = staleTopicQuestions({
      repo: REPO,
      open: [old, kept],
      drafted: [
        { topic: "harbor.audit.events", id: "q-333333333333" },
        { topic: "lantern.mail.outbox", id: "q-222222222222" },
      ],
    });
    expect(out).toEqual([
      {
        id: "q-111111111111",
        why: "harbor.audit.events is asked now in q-333333333333",
        replacedBy: ["q-333333333333"],
      },
    ]);
  });

  it("never retires an answered question, or another repo's or step's", () => {
    expect(
      staleTopicQuestions({
        repo: REPO,
        open: [
          question("q-111111111111", "harbor.audit.events", { state: "answered" }),
          question("q-222222222222", "harbor.audit.events", { repo: "forge-payments" }),
          question("q-333333333333", "harbor.audit.events", { step: "facts-targets" }),
        ],
        drafted: [],
      }),
    ).toEqual([]);
  });
});
