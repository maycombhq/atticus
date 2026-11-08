import { expect, it } from "vitest";
import { answerAudit } from "../src/audit-commands.js";

/**
 * Review rounds 33-34: the same answer again keeps who gave it and its note; a new note is the
 * person giving it, so nobody's words are recorded as someone else's.
 */
it("keeps the first answer when it comes again, and records a new note as its writer's", () => {
  const audit = {
    items: [
      { id: "fact:entry.a", answer: "right", by: "Ana", at: "2026-11-01T00:00:00Z", note: "ok" },
    ],
  } as never as Parameters<typeof answerAudit>[0];
  answerAudit(
    audit,
    new Map([["fact:entry.a", { answer: "right" }]]),
    "Ben",
    "2026-11-08T00:00:00Z",
  );
  expect(audit.items[0]).toMatchObject({ by: "Ana", at: "2026-11-01T00:00:00Z", note: "ok" });
  answerAudit(
    audit,
    new Map([["fact:entry.a", { answer: "right", note: "seen" }]]),
    "Ben",
    "2026-11-08T00:00:00Z",
  );
  expect(audit.items[0]).toMatchObject({ answer: "right", by: "Ben", note: "seen" });
  answerAudit(
    audit,
    new Map([["fact:entry.a", { answer: "wrong" }]]),
    "Cy",
    "2026-11-09T00:00:00Z",
  );
  expect(audit.items[0]).toMatchObject({ answer: "wrong", by: "Cy", at: "2026-11-09T00:00:00Z" });
  expect(audit.items[0]).not.toHaveProperty("note");
});
