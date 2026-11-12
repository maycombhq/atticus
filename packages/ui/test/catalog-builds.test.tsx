import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import {
  CatalogBuildsPage,
  ConfirmDialog,
  RefusalView,
  RemovalsTable,
  UpgradeChangesList,
  UpgradePanel,
  whyWords,
} from "../src/screens/setup/CatalogBuild.js";
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
      n: 1,
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
    { n: 3, command: "atticus scan", at: "2026-11-11T17:00:00.000Z", commit: null, files: 96 },
  ],
  plan: {
    n: 1,
    takesBack: [{ n: 1, command: "atticus catalog build --allow-removals 3" }],
    files: [{ path: "catalog/sources/build.json", to: "file" }],
  },
};
const fail = () => Promise.reject(new Error("no write in a render"));
/** The latest build's own report (CS2's build-report.json), as GET /api/build gives it. */
const report = (o: Partial<Api.BuildReportViewT> = {}): Api.BuildReportViewT => {
  const removed = o.removed ?? [];
  const added = o.added ?? [
    {
      path: "catalog/generated/endpoint/ledger-api.get-balance.yaml",
      kind: "Endpoint",
      id: "ledger-api.get-balance",
    },
  ];
  return {
    command: "atticus catalog build --allow-removals 3",
    at: "2026-11-11T18:02:00.000Z",
    generated: "catalog/generated",
    outcome: "written",
    run: [],
    counts: {
      records: 50,
      added: added.length,
      changed: 0,
      removed: removed.length,
      written: added.length,
      unchanged: 49,
    },
    added,
    changed: [],
    removed,
    slots: [],
    ...o,
  };
};

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

  it("lists the builds kept, newest first, each with its Undo", () => {
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
      build: view({ upToDate: true, removals: [] }, report({ removed: REMOVALS, undo: 4 })),
    });
    expect(out).toContain(esc(B.outcome.written!));
    expect(out).toContain(esc(B.lastIntro));
    expect(out).toContain(esc(B.lastCounts(1, 0, 3)));
    expect(out).toContain(esc(B.lastRemoved(3)));
    expect(out).toContain(esc(B.lastAdded(1)));
    expect(out).toContain("catalog/sources/readers/forge-gateway.json");
  });

  it("lists a terminal's refused build: why, what it would have removed, and the command on", () => {
    const out = page({
      build: view(
        { upToDate: false, removals: [], refused: LARGE },
        report({
          command: "atticus scan",
          outcome: "refused",
          refused: { ...LARGE, command: "atticus scan --allow-removals 3" },
          run: ["atticus scan --allow-removals 3"],
          removed: REMOVALS,
          added: [],
        }),
      ),
    });
    expect(out).toContain(esc(B.outcome.refused!));
    expect(out).toContain(esc(B.lastLine("atticus scan", "2026-11-11 18:02:00 UTC")));
    expect(out).toContain(esc(B.lastWouldCounts(0, 0, 3)));
    expect(out).toContain(esc(B.lastWouldRemove(3)));
    expect(out).toContain(esc(B.lastRun));
    expect(out).toContain("atticus scan --allow-removals 3");
    // Opened, since a refusal's list is what it says.
    expect(out).toMatch(/<details open="">\s*<summary>The 3 records it would have removed/);
  });

  it("says which repos a scan that read nothing couldn't read, and a stopped write", () => {
    const out = page({
      build: view(
        { upToDate: true, removals: [] },
        report({
          command: "atticus scan",
          outcome: "refused",
          refused: {
            reasons: ["nothing-read"],
            message: "x",
            unread: [{ repo: "forge-ledger", why: "it isn't cloned here" }],
            command: "atticus scan",
          },
          run: [],
          added: [],
        }),
      ),
    });
    expect(out).toContain(esc(B.reason["nothing-read"]!(0)));
    expect(out).toContain(esc(B.lastUnread));
    expect(out).toContain("it isn&#x27;t cloned here");
    const stopped = page({
      build: view(
        { upToDate: true, removals: [] },
        report({
          outcome: "stopped",
          stopped: "ENOSPC: no space left",
          run: ["atticus catalog build"],
        }),
      ),
    });
    expect(stopped).toContain(esc(B.outcome.stopped!));
    expect(stopped).toContain(esc(B.lastStopped("ENOSPC: no space left")));
  });

  it("names an answer that explains a removal as the person's own action", () => {
    const r: Api.BuildRemovalT = {
      path: "catalog/generated/interface/if-ledger-to-notify.yaml",
      kind: "Interface",
      id: "if-ledger-to-notify",
      repos: ["forge-ledger"],
      explainedBy: ["an input changed (questions)", "the build changed (1 to 2)"],
      reasons: ["input", "build"],
      inputs: [{ what: "answers", path: "questions" }],
    };
    expect(whyWords(r)).toEqual([B.input.answers!("questions"), "the build changed (1 to 2)"]);
    const out = html(<RemovalsTable removals={[r]} />);
    expect(out).toContain(esc(B.input.answers!("questions")));
    expect(out).not.toContain("an input changed (questions)");
    // Without inputs, the build's own words stand.
    expect(whyWords({ ...r, inputs: undefined } as Api.BuildRemovalT)).toEqual(r.explainedBy);
  });
});

const UPGRADE: Api.CatalogUpgradeViewT = {
  pending: true,
  records: 53,
  write: [
    { path: "catalog/sources/readers/forge-ledger.json", records: 31, repo: "forge-ledger" },
    { path: "catalog/sources/legacy/joins.json", records: 4 },
  ],
  writes: [
    {
      path: "catalog/sources/readers/forge-ledger.json",
      what: "readers-slot",
      bytes: 41210,
      sha256: "1".repeat(64),
    },
    {
      path: "catalog/sources/legacy/joins.json",
      what: "legacy-joins",
      bytes: 5120,
      sha256: "2".repeat(64),
    },
    {
      path: "catalog/sources/legacy/generated-before-upgrade/endpoint/ledger-api.get-balance.yaml",
      what: "copy",
      bytes: 512,
      sha256: "3".repeat(64),
    },
    {
      path: "catalog/sources/build.json",
      what: "build-manifest",
      bytes: 9000,
      sha256: "4".repeat(64),
    },
  ],
  copy: { dir: "catalog/sources/legacy/generated-before-upgrade", files: 1 },
  firstBuildChanges: [],
  changes: [],
  acceptChanges: 0,
  applies: true,
  run: "atticus upgrade --yes",
  verifiable: ["forge-ledger"],
  plan: "5".repeat(64),
  others: [],
};

describe("the upgrade to source slots, shown first and confirmed with its count", () => {
  const upgrade = (u: Partial<Api.CatalogUpgradeViewT> | "loading" | "error") =>
    page({
      build: ready<Api.CatalogBuildViewT>({
        sources: SOURCES,
        pending: {
          upToDate: false,
          removals: [],
          refused: {
            reasons: ["not-upgraded"],
            message: "x",
            edits: [],
            discardEdits: 53,
            command: "atticus upgrade",
          },
        },
        upgrade: true,
        orphaned: [],
        problems: [],
      }),
      upgrade:
        u === "loading"
          ? { state: "loading" }
          : u === "error"
            ? ({ state: "error", error: "boom", reload: () => undefined } as never)
            : ready({ ...UPGRADE, ...u }),
    });

  it("lists each slot, the copy kept and that the first build changes nothing, behind Review", () => {
    const out = upgrade({});
    expect(out).toContain(esc(B.upgradeTitle));
    expect(out).toContain(esc(B.upgradeRecords(53, 2)));
    expect(out).toContain("catalog/sources/readers/forge-ledger.json");
    expect(out).toContain(esc(B.upgradeJoins));
    expect(out).toContain(esc(B.upgradeCopy("catalog/sources/legacy/generated-before-upgrade", 1)));
    expect(out).toContain(esc(B.upgradeFirstBuild));
    expect(out).toContain(esc(B.upgradeVerifiable("forge-ledger")));
    expect(out).toContain(esc(B.upgradeReview(4)));
    expect(out).toContain("atticus upgrade --yes");
    // The confirm (with its count box) opens on Review, not before.
    expect(out).not.toContain('role="dialog"');
  });

  // As CS2's CLI: atticus upgrade --yes --accept-changes <n> (ADR 0195 CS2 addendum, types for CS3).
  const CHANGES: Partial<Api.CatalogUpgradeViewT> = {
    applies: false,
    firstBuildChanges: ["system/reports.yaml", "system/northwind-pay.yaml"],
    changes: [
      { path: "system/northwind-pay.yaml", how: "added" },
      { path: "system/reports.yaml", how: "changed" },
    ],
    acceptChanges: 2,
    run: "atticus upgrade --yes --accept-changes 2",
  };

  it("lists the records the first build would change, and asks to accept their count before the files", () => {
    const out = upgrade(CHANGES);
    expect(out).toContain(esc(B.upgradeDiffers(2)));
    expect(out).toContain("added: catalog/generated/system/northwind-pay.yaml");
    expect(out).toContain("changed: catalog/generated/system/reports.yaml");
    expect(out).toContain(esc(B.upgradeAccept(2)));
    // The files' confirm waits for the accept step; the terminal's command names the count.
    expect(out).not.toContain(esc(B.upgradeReview(4)));
    expect(out).toContain("atticus upgrade --yes --accept-changes 2");
    expect(out).not.toContain('role="dialog"');
  });

  it("offers the files' review once the changes are accepted with their count", () => {
    const out = html(
      <UpgradePanel of={ready({ ...UPGRADE, ...CHANGES })} onUpgrade={fail} accepted={2} />,
    );
    expect(out).toContain(esc(B.upgradeAccepted(2)));
    expect(out).toContain(esc(B.upgradeReview(4)));
    expect(out).not.toContain(esc(B.upgradeAccept(2)));
    // Accepted for another count, it asks again.
    const other = html(
      <UpgradePanel of={ready({ ...UPGRADE, ...CHANGES })} onUpgrade={fail} accepted={3} />,
    );
    expect(other).toContain(esc(B.upgradeAccept(2)));
    expect(other).not.toContain(esc(B.upgradeReview(4)));
  });

  it("the accept step lists each change and asks for their count", () => {
    const out = html(
      <ConfirmDialog
        title={B.upgradeAcceptTitle(2)}
        intro={B.upgradeAcceptIntro}
        confirm={B.confirmAccept(2)}
        count={2}
        onConfirm={fail}
        onClose={() => undefined}
      >
        <UpgradeChangesList changes={CHANGES.changes!} />
      </ConfirmDialog>,
    );
    expect(out).toContain(esc(B.upgradeAcceptTitle(2)));
    expect(out).toContain(esc(B.typeCount(2)));
    expect(out).toContain("added: catalog/generated/system/northwind-pay.yaml");
    expect(out).toMatch(/disabled=""[^>]*>Accept 2 changes/);
  });

  it("offers no accept while the other upgrade steps wait", () => {
    const out = upgrade({ ...CHANGES, others: [{ id: "q", summary: "Move the questions" }] });
    expect(out).toContain(esc(B.upgradeDiffers(2)));
    expect(out).not.toContain(esc(B.upgradeAccept(2)));
  });

  it("waits for the other upgrade steps first, and offers no confirm until they ran", () => {
    const out = upgrade({ others: [{ id: "questions-v2", summary: "Move the questions to v2" }] });
    expect(out).toContain(esc(B.upgradeOthers));
    // Home's own offer lists the steps and runs them (it loads itself, so not in a render).
    expect(out).not.toContain("Move the questions to v2");
    expect(out).not.toContain(esc(B.upgradeReview(4)));
  });

  it("has its loading, error and nothing-to-upgrade states", () => {
    expect(upgrade("loading")).toContain('aria-busy="true"');
    expect(upgrade("error")).toContain(COPY.app.tryAgain);
    expect(upgrade({ pending: false })).toContain(esc(B.upgradeNone));
    // A catalog already upgraded shows no upgrade panel at all.
    expect(page()).not.toContain(esc(B.upgradeTitle));
  });

  it("its confirm lists every file it writes, with what each is, and asks for their count", () => {
    const out = html(
      <ConfirmDialog
        title={B.upgradeConfirmTitle(4)}
        intro={B.upgradeConfirmIntro}
        confirm={B.confirmUpgrade(4)}
        count={4}
        onConfirm={fail}
        onClose={() => undefined}
      >
        <UpgradePanelFiles />
      </ConfirmDialog>,
    );
    expect(out).toContain('role="dialog"');
    expect(out).toContain(esc(B.typeCount(4)));
    expect(out).toMatch(/disabled=""[^>]*>Write 4 files/);
  });
});

/** The confirm's list as UpgradePanel renders it inside its dialog. */
function UpgradePanelFiles() {
  return (
    <ul className="cb-list mono" aria-label={B.upgradeFilesCaption}>
      {UPGRADE.writes.map((w) => (
        <li key={w.path}>
          {w.path} ({B.upgradeWhat[w.what]}, {B.upgradeBytes(w.bytes)})
        </li>
      ))}
    </ul>
  );
}

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
    // CS2's words: run atticus upgrade --yes (or Upgrade on Set up › Catalog builds).
    expect(B.reason["not-upgraded"]!(96)).toContain(
      "run atticus upgrade --yes (or Upgrade on Set up › Catalog builds)",
    );
    expect(out).toContain("atticus upgrade --yes");
    // Away from Catalog builds, a link to its upgrade step.
    expect(out).toContain('href="#/catalog-builds"');
    expect(out).toContain(esc(B.upgradeOn));
  });

  it("on Catalog builds, a refusal as not upgraded points to the upgrade step below", () => {
    const out = html(
      <RefusalView
        refused={{
          reasons: ["not-upgraded"],
          message: "x",
          edits: [],
          discardEdits: 96,
          command: "atticus upgrade",
        }}
        upgradeHere
        onAllowRemovals={fail}
      />,
    );
    expect(out).toContain(esc(B.upgradeTodo));
    expect(out).not.toContain('href="#/catalog-builds"');
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
