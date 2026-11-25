import { describe, expect, it } from "vitest";
import { CHANGE_SCHEMA_VERSION, ChangeLifecycle, changeSchemaVersionFor } from "../src/index.js";

/** ADR 0210 part 7: change.yaml version 2 carries open items; version 1 files read as they are. */
const V1 = {
  schemaVersion: 1,
  id: "add-transfer-limit",
  title: "Add transfer limit",
  type: "feature",
  state: "design",
  createdAt: "2026-11-24T09:00:00Z",
  createdBy: "pat",
  history: [{ from: "draft", to: "define", at: "2026-11-24T09:00:00Z", by: "pat" }],
  handoffs: [],
};
const ITEMS = ["Blocking finding f1 on the design gate (round 2): No retry budget."];

describe("change.yaml version 2", () => {
  it("is the current version", () => expect(CHANGE_SCHEMA_VERSION).toBe(2));

  it("reads a version 1 file unchanged, and keeps it at 1 while it has no open items", () => {
    const c = ChangeLifecycle.parse({
      ...V1,
      history: [
        ...V1.history,
        { from: "define", to: "design", at: "2026-11-24T10:00:00Z", by: "ari" },
      ],
    });
    expect(c.schemaVersion).toBe(1);
    expect(changeSchemaVersionFor(c)).toBe(1);
  });

  it("refuses a version 1 file that carries open items", () => {
    const r = ChangeLifecycle.safeParse({
      ...V1,
      history: [
        ...V1.history,
        { from: "define", to: "design", at: "2026-11-24T10:00:00Z", by: "ari", openItems: ITEMS },
      ],
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.message).toBe("openItems needs schemaVersion 2 (ADR 0210)");
  });

  it("is version 2 for a file with open items, on a hand-off or in its history", () => {
    const c = ChangeLifecycle.parse({
      ...V1,
      schemaVersion: 2,
      history: [
        ...V1.history,
        { from: "define", to: "design", at: "2026-11-24T10:00:00Z", by: "ari", openItems: ITEMS },
      ],
    });
    expect(c.schemaVersion).toBe(2);
    expect(changeSchemaVersionFor(c)).toBe(2);
    expect(changeSchemaVersionFor({ ...c, history: [] })).toBe(2);
  });
});
