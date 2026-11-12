import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { CatalogBuildsPage, RefusalView } from "../src/screens/setup/CatalogBuild.js";
import { scanBuildRefusal, scanSources, ScanSourcesTable } from "../src/screens/know/Know.js";

/**
 * ADR 0195 points 4 and 7 (ticket CS3): Set up › Scans › Catalog builds. Every state says itself
 * in the copy file's words; a refused build lists what it would remove (with what explains each)
 * and the hand edits, and each step only opens its confirm, which lists exactly what it changes.
 * Forge-shaped data: seven repos, the ledger from its facts, a gateway read that lost most of its
 * records, a hand edit, the undo copies of three builds, an archived repo's slot to prune.
 */

const B = COPY.catalogBuild;
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
const ready = <T,>(data: T) => ({ state: "ready" as const, data });
const A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const SOURCES: Api.CatalogBuildViewT["sources"] = [
  {
    repo: "forge-portal-ui",
    source: "readers",
    commit: A,
    slot: "catalog/sources/readers/forge-portal-ui.json",
  },
  { repo: "forge-portal-bff", source: "readers", commit: A },
  { repo: "forge-ledger", source: "facts", commit: "0123abc" },
  { repo: "forge-reports-job", source: "legacy", commit: "unknown" },
  { repo: "forge-gateway", source: "readers", commit: A },
  { repo: "forge-events", source: "readers", commit: A },
  { repo: "forge-infra", source: "none" },
];
const removal = (id: string): Api.BuildRemovalT => ({
  path: `catalog/generated/gatewayroute/${id}.yaml`,
  kind: "GatewayRoute",
  id,
  repos: ["forge-gateway"],
  explainedBy: ["catalog/sources/readers/forge-gateway.json"],
});
const REMOVALS = ["gw-ledger-v1-accounts", "gw-ledger-v1-transfers", "gw-ledger-v1-balance"].map(
  removal,
);
const LARGE: Api.BuildRefusalViewT = {
  reasons: ["large-removals"],
  message: "Nothing written: …",
  removals: REMOVALS,
  allowRemovals: 3,
  command: "atticus catalog build --allow-removals 3",
};
const EDITS: Api.BuildRefusalViewT = {
  reasons: ["hand-edits"],
  message: "Nothing written: …",
  edits: [{ path: "catalog/generated/table/ledger-db.account.yaml", how: "changed" }],
  discardEdits: 1,
  command: "atticus catalog edits --curate",
};
const view = (pending: Api.CatalogBuildViewT["pending"], last?: Api.CatalogBuildViewT["last"]) =>
  ready<Api.CatalogBuildViewT>({
    sources: SOURCES,
    pending,
    ...(last ? { last } : {}),
    orphaned: [],
    problems: [],
  });
const UNDO: Api.CatalogUndoViewT = {
  copies: [
    {
      n: 3,
      command: "atticus catalog build --allow-removals 3",
      at: "2026-11-11T18:02:00.000Z",
      commit: null,
      files: 5,
    },
    {
      n: 2,
      command: "atticus catalog edits --curate",
      at: "2026-11-11T17:40:00.000Z",
      commit: null,
      files: 2,
    },
    { n: 1, command: "atticus scan", at: "2026-11-11T17:00:00.000Z", commit: null, files: 96 },
  ],
  plan: {
    n: 3,
    takesBack: [{ n: 3, command: "atticus catalog build --allow-removals 3" }],
    files: [{ path: "catalog/sources/build.json", to: "file" }],
  },
};
const fail = () => Promise.reject(new Error("no write in a render"));

const page = (o: Partial<Parameters<typeof CatalogBuildsPage>[0]> = {}) =>
  html(
    <CatalogBuildsPage
      build={view({ upToDate: true, removals: [] })}
      undo={ready(UNDO)}
      prune={ready({ files: [] })}
      run={fail}
      plan={fail}
      {...o}
    />,
  );

describe("Catalog builds, in every state", () => {
  it("says it is loading, and why a load failed", () => {
    expect(page({ build: { state: "loading" } })).toContain('aria-busy="true"');
    const out = page({
      build: { state: "error", error: "boom", reload: () => undefined } as never,
    });
    expect(out).toContain('role="alert"');
    expect(out).toContain(COPY.app.tryAgain);
  });

  it("says nothing waits, where each repo's records come from, and the legacy label", () => {
    const out = page();
    expect(out).toContain(esc(B.upToDate));
    expect(out).toContain(esc(B.source.facts!));
    expect(out).toContain(esc(B.source.legacy!));
    expect(out).toContain(esc(COPY.crossCheck.state.legacy!));
    expect(out).toContain(esc(B.source.none!));
    expect(out).toContain('href="#/crosscheck"');
  });

  it("says no build, no copy and nothing to prune on a fresh metarepo", () => {
    const out = page({ undo: ready({ copies: [], problem: "There is nothing to undo" }) });
    expect(out).toContain(esc(B.lastNone));
    expect(out).toContain(esc(B.undoNone));
    expect(out).toContain(esc(B.pruneNone));
  });

  it("lists the undo copies, newest first, each with Undo to before", () => {
    const out = page();
    expect(out.indexOf("atticus catalog build --allow-removals 3")).toBeLessThan(
      out.indexOf("atticus catalog edits --curate"),
    );
    for (const n of [3, 2, 1]) expect(out).toContain(`aria-label="${esc(B.undoToOf(n))}"`);
  });

  it("lists the slot files to prune, each with why, behind Remove these", () => {
    const out = page({
      prune: ready({
        files: [
          {
            path: "catalog/sources/readers/forge-reports-job.json",
            why: "forge-reports-job is archived",
          },
        ],
      }),
    });
    expect(out).toContain("catalog/sources/readers/forge-reports-job.json");
    expect(out).toContain("forge-reports-job is archived");
    expect(out).toContain(esc(B.pruneReview(1)));
  });

  it("says what the last build changed and what explains each removal", () => {
    const out = page({
      build: view(
        { upToDate: true, removals: [] },
        {
          n: 3,
          command: "atticus catalog build --allow-removals 3",
          at: "2026-11-11T18:02:00.000Z",
          added: [],
          changed: [],
          removed: REMOVALS,
          slots: [],
        },
      ),
    });
    expect(out).toContain(esc(B.lastCounts(0, 0, 3)));
    expect(out).toContain(esc(B.lastRemoved(3)));
    expect(out).toContain("catalog/sources/readers/forge-gateway.json");
  });
});

describe("a refused build: its list and its ways on, nothing written until confirmed", () => {
  it("names a large removal with its count and opens its confirm only on a press", () => {
    const out = page({ build: view({ upToDate: false, removals: [], refused: LARGE }) });
    expect(out).toContain(esc(B.refusedTitle));
    expect(out).toContain(esc(B.reason["large-removals"]!(3)));
    expect(out).toContain(esc(B.reviewRemovals(3)));
    // The dialog (and its count box) opens on Review, not before.
    expect(out).not.toContain('role="dialog"');
    expect(out).toContain("atticus catalog build --allow-removals 3");
  });

  it("offers Make it curated and Discard for a hand edit, with the file listed", () => {
    const out = page({ build: view({ upToDate: false, removals: [], refused: EDITS }) });
    expect(out).toContain(esc(B.reason["hand-edits"]!(1)));
    expect(out).toContain("changed: catalog/generated/table/ledger-db.account.yaml");
    expect(out).toContain(esc(B.curate(1)));
    expect(out).toContain(esc(B.discard(1)));
  });

  it("says an unexplained removal is a bug, lists it, and offers no confirm", () => {
    const out = html(
      <RefusalView
        refused={{
          reasons: ["unexplained-removals"],
          message: "Nothing written",
          unexplained: [removal("gw-ledger-v1-orphan")],
          command: "atticus catalog build",
        }}
        onAllowRemovals={fail}
      />,
    );
    expect(out).toContain(esc(B.reason["unexplained-removals"]!(1)));
    expect(out).toContain("GatewayRoute/gw-ledger-v1-orphan");
    expect(out).not.toContain(">Review the");
  });

  it("names the upgrade for a catalog from before beta.27", () => {
    const out = html(
      <RefusalView
        refused={{
          reasons: ["not-upgraded"],
          message: "x",
          edits: [],
          discardEdits: 96,
          command: "atticus upgrade",
        }}
        onAllowRemovals={fail}
      />,
    );
    expect(out).toContain(esc(B.reason["not-upgraded"]!(96)));
    expect(out).toContain("atticus upgrade");
  });
});

describe("Set up › Scans says what a scan read of each repo", () => {
  const job = {
    state: "done",
    result: {
      sources: [
        {
          repo: "forge-ledger",
          source: "facts",
          sourceCommit: "0123abc",
          slot: "written",
          commit: A,
        },
        {
          repo: "forge-gateway",
          source: "readers",
          slot: "kept-last-good",
          commit: A,
          reason: "not-cloned",
        },
        {
          repo: "forge-infra",
          source: "none",
          slot: "none",
          reason: "run-failed",
          detail: "terraform@1.0.0",
        },
      ],
    },
  };

  it("reads each repo's outcome from the job's result", () => {
    expect(scanSources(job).map((s) => s.slot)).toEqual(["written", "kept-last-good", "none"]);
    expect(scanSources({ state: "running" })).toEqual([]);
  });

  it("shows read in full, kept its last good read and why", () => {
    const out = html(<ScanSourcesTable sources={scanSources(job)} />);
    expect(out).toContain(esc(COPY.scanSources.slot.written!));
    expect(out).toContain(esc(COPY.scanSources.slot["kept-last-good"]!));
    expect(out).toContain(esc(COPY.scanSources.why["not-cloned"]!));
    expect(out).toContain("terraform@1.0.0");
    expect(out).toContain(esc(COPY.scanSources.at("aaaaaaa")));
  });

  it("takes a scan's build refusal (large removals) as one to confirm, with the scan's command", () => {
    const r = scanBuildRefusal({
      state: "failed",
      result: {
        refused: {
          reasons: ["large-removals"],
          removals: REMOVALS,
          allowRemovals: 3,
          message: "x",
          repos: [],
        },
      },
    });
    expect(r?.command).toBe("atticus scan --allow-removals 3");
    expect(
      scanBuildRefusal({
        state: "failed",
        result: { refused: { reasons: ["nothing-read"], repos: [] } },
      }),
    ).toBeUndefined();
  });
});
