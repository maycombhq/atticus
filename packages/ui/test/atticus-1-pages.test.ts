import { describe, expect, it } from "vitest";
import { hasDiagrams } from "../src/screens/know/Design.js";
import { hopSource, listsArtifact } from "../src/screens/know/Phase.js";
import { COPY } from "../src/copy.js";

// Atticus 1's pages under More pages on an Atticus 2 change (2026-10-25): the feature brief,
// prototypes, architecture review and API mappings asked for artifacts an Atticus 2 change never
// has (proposal, ux, interfaces, mappings) and reconcile ran with no diagrams, each answered with
// an HTTP error. Now each asks only for what is there, and says what Atticus 2 writes instead.

const detail = (...artifacts: string[]) => ({
  artifacts: artifacts.map((artifact) => ({
    artifact,
    path: `openspec/changes/add-note-tags/${artifact}.md`,
    status: "done" as const,
    openFindings: 0,
  })),
});

describe("a change's artifact on an Atticus 1 page", () => {
  it("is asked for only when the change lists it", () => {
    const studio = detail("design", "stories", "tasks", "brief");
    expect(listsArtifact(studio, "brief")).toBe(true);
    expect(listsArtifact(studio, "design")).toBe(true);
    for (const a of ["proposal", "ux", "interfaces", "mappings"])
      expect(listsArtifact(studio, a), a).toBe(false);
  });

  it("waits for the change's detail, and asks anyway when the detail can't be read", () => {
    expect(listsArtifact(undefined, "ux")).toBeUndefined();
    expect(listsArtifact("error", "ux")).toBe(true);
  });

  it("says what an Atticus 2 change has instead", () => {
    const words = COPY.phase.noSuchArtifact("interfaces");
    expect(words).toMatch(/has no interfaces/);
    expect(words).toMatch(/Atticus 2/);
  });
});

describe("reconcile", () => {
  it("runs only when inputs/diagrams/ holds a diagram it reads", () => {
    const doc = (path: string) => ({ path });
    expect(hasDiagrams(undefined)).toBeUndefined();
    expect(hasDiagrams({ documents: [] })).toBe(false);
    expect(hasDiagrams({ documents: [doc("inputs/wiki/runbook.md")] })).toBe(false);
    expect(hasDiagrams({ documents: [doc("inputs/diagrams/notes.txt")] })).toBe(false);
    for (const f of [
      "ledger.drawio",
      "ledger.drawio.xml",
      "a/b.vsdx",
      "c.mmd",
      "d.mermaid",
      "e.csv",
    ])
      expect(hasDiagrams({ documents: [doc(`inputs/diagrams/${f}`)] }), f).toBe(true);
    expect(hasDiagrams("error")).toBe(true);
  });
});

// ADR 0129 section 2.3: API mappings read mappings.md and nothing else, so on a change taken
// through the stages — which never write that file — the page was empty. It now reads the
// architecture stage's target flows, and each hop says which file it came from.
describe("where a field-mapping hop was read from", () => {
  it("names mappings.md, or the target flow, in the reader's words", () => {
    expect(hopSource("mappings.md")).toBe("from mappings.md");
    expect(hopSource("target-flows/forge-orders.place-order.yaml")).toBe(
      "from the target flow forge-orders.place-order",
    );
  });

  it("says nothing when the API didn't say, so an older server's answer still renders", () => {
    expect(hopSource(undefined)).toBeUndefined();
  });

  it("tells a reader with no hops where they come from, not only which file to write", () => {
    expect(COPY.phase.noHopsInMappings).toMatch(/target flows/);
    expect(COPY.phase.noHopsInMappings).toMatch(/mappings\.md/);
  });
});
