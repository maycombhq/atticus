import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoveredFrom, freeFolder, isMetarepoName } from "../src/start";

/** ADR 0098: starting from nothing, and adding repos without editing YAML. */

describe("what repos discover found", () => {
  it("reads the repos and their types from the dry run, and how many questions it has", () => {
    const out = [
      "  forge-events: event-config (topics/payments.initiated.yaml)",
      "  forge-ledger: unknown",
      "  forge-portal-ui: frontend (package.json)",
      "Found 3 repos; nothing written (dry run).",
      "16 questions need a person.",
    ].join("\n");
    expect(discoveredFrom(out)).toEqual({
      repos: [
        { id: "forge-events", type: "event-config", evidence: "topics/payments.initiated.yaml" },
        { id: "forge-ledger", type: "unknown" },
        { id: "forge-portal-ui", type: "frontend", evidence: "package.json" },
      ],
      questions: 16,
    });
    expect(discoveredFrom("Found 0 repos; nothing written (dry run).")).toEqual({
      repos: [],
      questions: 0,
    });
  });
});

describe("a new metarepo's name", () => {
  it("takes a folder name a metarepo can have", () => {
    expect(isMetarepoName("forge-meta")).toBe(true);
    expect(isMetarepoName("Forge Meta")).toBe(false);
    expect(isMetarepoName("")).toBe(false);
  });
});

describe("a folder of its own (ADR 0119)", () => {
  it("takes the name, else the next number free", () => {
    const taken = new Set(["/w/atticus-practice", "/w/atticus-practice-2"].map((p) => join(p)));
    const exists = (p: string) => taken.has(join(p));
    expect(freeFolder("/w", "atticus-practice", exists)).toBe(join("/w", "atticus-practice-3"));
    expect(freeFolder("/w", "other", exists)).toBe(join("/w", "other"));
  });
});
