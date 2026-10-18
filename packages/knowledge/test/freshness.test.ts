import { describe, expect, it } from "vitest";
import { freshness } from "../src/index.js";
import { forgePack, record } from "./helpers.js";

const NOW = "2026-10-18T00:00:00Z";

const setting = (id: string, scannedAt?: string, commit?: string) =>
  record({
    kind: "Setting",
    id,
    confidence: "verified",
    component: "ledger-api",
    settingKind: "timeout",
    key: id,
    valueOrRef: "1s",
    evidence: [
      {
        source: "config",
        repo: "forge-ledger",
        path: "forge.yaml",
        ...(scannedAt ? { scannedAt } : {}),
        ...(commit ? { commit } : {}),
      },
    ],
  });

const doc = (id: string, extra: Record<string, unknown>) =>
  record({
    kind: "SourceDocument",
    id,
    confidence: "verified",
    path: `wiki/${id}.md`,
    docType: "wiki-page",
    hash: "a".repeat(64),
    evidence: [{ source: "document", path: `wiki/${id}.md` }],
    ...extra,
  });

describe("freshness", () => {
  it("reports records whose newest evidence is older than the pack's window for their kind", async () => {
    const op = await forgePack();
    const res = freshness({
      records: [
        setting("old", "2026-01-01T00:00:00Z"),
        setting("new", "2026-10-01T00:00:00Z"),
        setting("undated"),
        record({
          kind: "System",
          id: "sys",
          confidence: "verified",
          name: "Sys",
          boundary: "product",
          evidence: [{ source: "config", path: "a.yaml", scannedAt: "2024-01-01T00:00:00Z" }],
        }),
      ],
      now: NOW,
      orgPack: op,
    });
    // Setting: 180 days in the Forge pack; System has no window there, so the default (365) applies.
    expect(res.stale).toEqual([
      { id: "old", kind: "Setting", newest: "2026-01-01T00:00:00Z", ageDays: 290, maxDays: 180 },
      { id: "sys", kind: "System", newest: "2024-01-01T00:00:00Z", ageDays: 1021, maxDays: 365 },
    ]);
    expect(res.undated).toEqual(["undated"]);
  });

  it("dates evidence by commit when the commit's date is known", async () => {
    const res = freshness({
      records: [setting("by-commit", undefined, "abc1234")],
      now: NOW,
      commitDates: { abc1234: "2025-01-01T00:00:00Z" },
      defaultDays: 100,
    });
    expect(res.stale).toEqual([
      {
        id: "by-commit",
        kind: "Setting",
        newest: "2025-01-01T00:00:00Z",
        ageDays: 655,
        maxDays: 100,
      },
    ]);
  });

  it("reports superseded and stale documents", () => {
    const res = freshness({
      records: [
        doc("spec-v1", { supersededBy: "doc.spec-v2", date: "2026-09-01" }),
        doc("ancient", { date: "2023-03-01" }),
        doc("recent", { date: "2026-09-01" }),
      ],
      now: NOW,
    });
    expect(res.documents).toEqual([
      {
        id: "ancient",
        path: "wiki/ancient.md",
        reason: "stale",
        date: "2023-03-01",
        ageDays: 1327,
        maxDays: 365,
      },
      { id: "spec-v1", path: "wiki/spec-v1.md", reason: "superseded", supersededBy: "doc.spec-v2" },
    ]);
    // Documents are reported once, under documents, not again as stale records.
    expect(res.stale).toEqual([]);
  });
});
