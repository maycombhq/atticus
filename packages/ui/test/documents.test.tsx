import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { screenOf, tabsOf } from "../src/app/screens.js";
import { ageOf, DocumentsView, filterDocuments } from "../src/screens/knowledge/Documents.js";

/** The Documents tab (ADR 0122): the files in inputs/, read or not, with their items. */

const D = COPY.knowledge.documents;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const NOW = Date.parse("2026-10-24T12:00:00Z");

const DATA: Api.DocumentListT = {
  snapshot: { date: "2026-10-24" },
  commands: ["atticus sources sync --source inputs", "atticus knowledge scan --source inputs"],
  documents: [
    {
      path: "inputs/decisions/ledger-owns-limits.md",
      kind: "document",
      title: "Decision: the ledger owns transfer limits",
      systems: ["forge-ledger"],
      state: "read",
      inbox: false,
      modifiedAt: "2026-10-21T09:00:00Z",
      items: [
        { id: "ledger-owns-limits", title: "The ledger owns transfer limits", verified: true },
      ],
    },
    {
      path: "inputs/forge-pay-runbook-v1.txt",
      kind: "document",
      systems: ["forge-pay"],
      state: "skipped",
      reason: "an older version: inputs/forge-pay-runbook-v2.txt is newer, and is the one read",
      supersededBy: "inputs/forge-pay-runbook-v2.txt",
      inbox: false,
      items: [],
    },
    {
      path: "inputs/inbox/whiteboard.png",
      kind: "image",
      systems: [],
      state: "skipped",
      reason: "a picture: a person reads it, since AI steps take text only",
      inbox: true,
      items: [],
    },
  ],
};

describe("the Documents tab (ADR 0122)", () => {
  it("is a tab of Knowledge", () => {
    expect(screenOf("documents")?.section).toBe("Knowledge");
    expect(tabsOf("Knowledge").map((t) => t.id)).toContain("documents");
  });

  it("shows each file: kind, whether it was read and why not, its age and its items", () => {
    const out = renderToStaticMarkup(<DocumentsView data={DATA} now={NOW} />);
    expect(out).toContain(esc(D.synced("2026-10-24", 1, 3)));
    expect(out).toContain("inputs/decisions/ledger-owns-limits.md");
    expect(out).toContain(esc(D.states.read!));
    expect(out).toContain(esc(D.states.skipped!));
    expect(out).toContain(
      esc(D.why("a picture: a person reads it, since AI steps take text only")),
    );
    expect(out).toContain(esc(D.items(1, 1)));
    expect(out).toContain(esc(D.age(3)));
    expect(out).toContain(esc(D.inbox));
    expect(out).toContain("The ledger owns transfer limits");
    expect(out).toContain(esc(D.kinds.image!));
  });

  it("filters by kind, system and words", () => {
    expect(filterDocuments(DATA.documents, { kind: "image", system: "", text: "" })).toHaveLength(
      1,
    );
    expect(
      filterDocuments(DATA.documents, { kind: "", system: "forge-pay", text: "" }),
    ).toHaveLength(1);
    expect(filterDocuments(DATA.documents, { kind: "", system: "", text: "LEDGER" })).toHaveLength(
      1,
    );
    expect(filterDocuments(DATA.documents, { kind: "", system: "", text: "" })).toHaveLength(3);
  });

  it("says a file's age in days, and nothing without a date", () => {
    expect(ageOf("2026-10-24T08:00:00Z", NOW)).toBe(D.age(0));
    expect(ageOf(undefined, NOW)).toBeUndefined();
  });

  it("says when inputs/ was never synced", () => {
    const out = renderToStaticMarkup(
      <DocumentsView data={{ ...DATA, snapshot: null }} now={NOW} />,
    );
    expect(out).toContain(esc(D.neverSynced));
  });
});
