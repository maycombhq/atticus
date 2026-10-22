import { describe, expect, it } from "vitest";
import { parseRecord, Sources, KNOWLEDGE_KINDS, knowledgeKindOf } from "../src/index.js";

// ADR 0083: knowledge items in the extended C1 kinds, and tags on knowledge sources (C6).

const quote = {
  source: "forge-wiki",
  page: "integration-patterns.md",
  section: "P3: File transfer",
  text: "All file transfers go through Harbour MFT.",
  snapshot: "2026-10-21",
  line: 30,
};
const base = {
  schemaVersion: 2,
  status: "current",
  confidence: "inferred",
  evidence: [
    {
      source: "document",
      path: "knowledge/snapshots/forge-wiki/2026-10-21/integration-patterns.md",
      line: 30,
    },
  ],
};

describe("knowledge kinds", () => {
  it("reads a Pattern drafted from a wiki: applies-when, rules and the quote", () => {
    const r = parseRecord({
      ...base,
      kind: "Pattern",
      id: "file-transfer",
      code: "file-transfer",
      name: "File transfer through Harbour MFT",
      patternKind: "integration-pattern",
      appliesWhen: "A partner can exchange only files.",
      rules: ["All file transfers go through Harbour MFT."],
      handledBy: "Enterprise Architecture",
      quote,
      patternStatus: "to-review",
    });
    expect(r.ok, JSON.stringify(!r.ok && r.issues)).toBe(true);
  });

  it("reads a standard as a Pattern with no interaction", () => {
    const r = parseRecord({
      ...base,
      kind: "Pattern",
      id: "anvil-logging",
      code: "anvil-logging",
      name: "Anvil logging",
      patternKind: "standard",
      appliesWhen: "Any backend service on Anvil 3 writes logs.",
      rules: [],
      framework: "anvil",
      quote,
      patternStatus: "to-review",
    });
    expect(r.ok, JSON.stringify(!r.ok && r.issues)).toBe(true);
  });

  it("reads a ProcessDefinition: request type with lead time, handler, catalogue item and inputs", () => {
    const r = parseRecord({
      ...base,
      kind: "ProcessDefinition",
      id: "mft-route-request",
      title: "MFT route",
      processKind: "request",
      appliesWhen: "A new file transfer between Forge and a partner.",
      leadTime: "10 working days",
      handledBy: "Integration team",
      catalogueItem: "MFT route",
      inputs: ["source", "destination"],
      quote,
    });
    expect(r.ok, JSON.stringify(!r.ok && r.issues)).toBe(true);
  });

  it("a ProcessDefinition needs applies-when and a quote", () => {
    const r = parseRecord({
      ...base,
      kind: "ProcessDefinition",
      id: "x",
      title: "X",
      processKind: "process",
    });
    expect(r.ok).toBe(false);
  });

  it("reads a Decision from a wiki: a ban, no reason or decider stated", () => {
    const r = parseRecord({
      ...base,
      kind: "Decision",
      id: "no-cross-service-database",
      title: "No reads from another service's database (AD-15)",
      decision: "A service never connects to a database owned by another service.",
      decisionKind: "decision",
      stance: "banned",
      appliesWhen: "A service wants data owned by another service.",
      quote,
      alsoOn: [{ ...quote, page: "integration-patterns.md" }],
    });
    expect(r.ok, JSON.stringify(!r.ok && r.issues)).toBe(true);
  });

  it("a Decision written by a person still reads as before", () => {
    const r = parseRecord({
      ...base,
      confidence: "asserted",
      evidence: [{ source: "manual", by: "a.architect" }],
      kind: "Decision",
      id: "adr-1",
      title: "T",
      decision: "D",
      reason: "R",
      decidedBy: "a.architect",
      date: "2026-10-01",
    });
    expect(r.ok).toBe(true);
  });

  it("maps a record to its knowledge kind", () => {
    expect(KNOWLEDGE_KINDS).toEqual([
      "pattern",
      "standard",
      "process",
      "request",
      "decision",
      "constraint",
    ]);
    expect(knowledgeKindOf({ kind: "Pattern", patternKind: "standard" } as never)).toBe("standard");
    expect(knowledgeKindOf({ kind: "Pattern" } as never)).toBe("pattern");
    expect(knowledgeKindOf({ kind: "ProcessDefinition", processKind: "request" } as never)).toBe(
      "request",
    );
    expect(knowledgeKindOf({ kind: "Decision", decisionKind: "constraint" } as never)).toBe(
      "constraint",
    );
    expect(knowledgeKindOf({ kind: "Decision" } as never)).toBe("decision");
    expect(knowledgeKindOf({ kind: "System" } as never)).toBeUndefined();
  });
});

describe("tags on knowledge sources", () => {
  it("a wiki can carry kinds, frameworks and an owner", () => {
    const s = Sources.parse({
      schemaVersion: 1,
      wikis: [
        {
          id: "forge-wiki",
          type: "markdown-folder",
          location: "../wiki",
          owner: "Enterprise Architecture",
          tags: { kinds: ["integration-patterns", "security-standard"], frameworks: ["anvil"] },
        },
      ],
    });
    expect(s.wikis[0]!.tags).toEqual({
      kinds: ["integration-patterns", "security-standard"],
      frameworks: ["anvil"],
    });
  });

  it("tags are free text but not empty", () => {
    expect(
      Sources.safeParse({
        schemaVersion: 1,
        wikis: [{ id: "w", type: "markdown-folder", location: "w", tags: { kinds: [""] } }],
      }).success,
    ).toBe(false);
    expect(
      Sources.safeParse({
        schemaVersion: 1,
        wikis: [{ id: "w", type: "markdown-folder", location: "w", tags: { kinds: ["our-own"] } }],
      }).success,
    ).toBe(true);
  });
});

describe("a wiki kept in git (ADR 0101)", () => {
  it("names its repository, branch and folder, cloned by default", () => {
    const s = Sources.parse({
      schemaVersion: 1,
      wikis: [
        {
          id: "platform-wiki",
          type: "git",
          location: "https://git.example.com/forge/platform.wiki.git",
          ref: "main",
          path: "docs",
        },
      ],
    });
    expect(s.wikis[0]).toMatchObject({ type: "git", ref: "main", path: "docs", checkout: "clone" });
  });

  it("can be a submodule of the metarepo instead", () => {
    const s = Sources.parse({
      schemaVersion: 1,
      wikis: [{ id: "runbooks", type: "git", location: "../runbooks", checkout: "submodule" }],
    });
    expect(s.wikis[0]!.checkout).toBe("submodule");
  });

  it("takes a branch, a folder and a checkout only for a git wiki, and a folder inside it", () => {
    const bad = (w: Record<string, unknown>) =>
      Sources.safeParse({ schemaVersion: 1, wikis: [{ id: "w", location: "w", ...w }] }).success;
    expect(bad({ type: "markdown-folder", ref: "main" })).toBe(false);
    expect(bad({ type: "confluence", checkout: "submodule" })).toBe(false);
    expect(bad({ type: "git", path: "../outside" })).toBe(false);
    expect(bad({ type: "git", path: "docs/how-to" })).toBe(true);
  });
});
