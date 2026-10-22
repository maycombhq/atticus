import { describe, expect, it } from "vitest";
import { discoveredFrom, isMetarepoName } from "../src/start";

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
