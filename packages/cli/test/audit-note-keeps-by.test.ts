import { expect, it } from "vitest";
import { answerAudit } from "../src/audit-commands.js";

/** Review round 33: a note on an answer already on file keeps who answered it, and when. */
it("keeps the first person's answer when another adds only a note", () => {
  const audit = {
    items: [{ id: "fact:entry.a", answer: "right", by: "Ana", at: "2026-11-01T00:00:00Z" }],
  } as never as Parameters<typeof answerAudit>[0];
  answerAudit(
    audit,
    new Map([["fact:entry.a", { answer: "right", note: "seen" }]]),
    "Ben",
    "2026-11-08T00:00:00Z",
  );
  expect(audit.items[0]).toMatchObject({
    answer: "right",
    by: "Ana",
    at: "2026-11-01T00:00:00Z",
    note: "seen",
  });
  answerAudit(
    audit,
    new Map([["fact:entry.a", { answer: "wrong" }]]),
    "Ben",
    "2026-11-08T00:00:00Z",
  );
  expect(audit.items[0]).toMatchObject({ answer: "wrong", by: "Ben", at: "2026-11-08T00:00:00Z" });
});
