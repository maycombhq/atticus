import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { SourceList } from "../src/screens/knowledge/Sources.js";
import { ChangeKnowledgeView } from "../src/screens/work/Knowledge.js";

/**
 * Many wikis in the app (ADR 0132): each source's authority and where it applies on the Sources
 * page, and an attached page's source and authority on a change's knowledge. Invented Forge data.
 */

const S = COPY.knowledge.sources;
const K = COPY.changeKnowledge;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const commands = (id: string) => ({
  sync: `atticus sources sync --source ${id}`,
  scan: `atticus knowledge scan --source ${id}`,
  slash: `/atticus-knowledge ${id}`,
});

const list: Api.KnowledgeSourceListT = {
  file: "org-pack/sources.yaml",
  types: ["confluence-export", "markdown-folder"],
  kindSuggestions: [],
  staleDays: 14,
  sources: [
    {
      id: "ea-standards",
      type: "confluence-export",
      location: "../wikis/ea-standards",
      tags: { kinds: [], frameworks: [] },
      authority: "standard",
      byPage: 1,
      stale: true,
      commands: commands("ea-standards"),
    },
    {
      id: "gcp-platform",
      type: "markdown-folder",
      location: "../wikis/gcp-platform",
      tags: { kinds: [], frameworks: [] },
      authority: "platform",
      appliesTo: { platforms: ["gcp"], newComponents: true },
      scope: "platforms gcp; new components",
      maxPages: 200,
      stale: true,
      commands: commands("gcp-platform"),
    },
    {
      id: "identity-team",
      type: "markdown-folder",
      location: "../wikis/identity-team",
      tags: { kinds: [], frameworks: [] },
      stale: true,
      commands: commands("identity-team"),
    },
  ],
  problems: [],
};

describe("the Sources page with many wikis", () => {
  it("shows each source's authority, its page overrides, where it applies and its cap", () => {
    const out = renderToStaticMarkup(
      <SourceList of={{ state: "ready", data: list }} onSync={() => undefined} />,
    );
    expect(out).toContain(esc(S.authorities.standard!));
    expect(out).toContain(esc(S.byPage(1)));
    expect(out).toContain(esc("platforms gcp; new components"));
    expect(out).toContain(esc(S.maxPages(200)));
    // A source with neither: a team's, everywhere.
    expect(out).toContain(esc(S.noAuthority));
    expect(out).toContain(esc(S.everywhere));
    expect(out).toContain(esc(S.skipsRestricted));
  });

  it("has its loading, error and empty states", () => {
    const loading = renderToStaticMarkup(
      <SourceList of={{ state: "loading" }} onSync={() => undefined} />,
    );
    expect(loading).toMatch(/aria-busy|Loading/i);
    const empty = renderToStaticMarkup(
      <SourceList
        of={{ state: "ready", data: { ...list, sources: [] } }}
        onSync={() => undefined}
      />,
    );
    expect(empty).toContain(esc(S.empty));
  });
});

describe("a change's knowledge with many wikis", () => {
  it("names the source of each attached page and how much its word counts", () => {
    const view: Api.ChangeKnowledgeViewT = {
      change: "forge-refunds",
      file: "openspec/changes/forge-refunds/knowledge.yaml",
      present: true,
      items: [
        {
          id: "idempotency-keys",
          kind: "Pattern",
          status: "suggested",
          stages: ["stories"],
          score: 1.2,
          title: "Idempotency keys",
          source: "ea-standards",
          authority: "standard",
        },
        {
          id: "caller-customer-check",
          kind: "ProcessDefinition",
          status: "suggested",
          stages: ["stories"],
          score: 1,
          title: "Check the caller's customer id",
          source: "identity-team",
        },
      ],
      nearMisses: [],
      command: "atticus change knowledge forge-refunds",
    };
    const out = renderToStaticMarkup(
      <ChangeKnowledgeView change="forge-refunds" of={{ state: "ready", data: view }} />,
    );
    expect(out).toContain(esc(K.fromSource("ea-standards", "standard")));
    expect(out).toContain(esc(K.fromSource("identity-team")));
  });
});
