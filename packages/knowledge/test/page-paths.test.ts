import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { loadOrgPack, type OrgPack } from "@maycombhq/core";
import {
  confluenceExportAdapter,
  readSnapshot,
  sharepointExportAdapter,
  syncSources,
  writeSnapshots,
  type KnowledgeSourceAdapter,
} from "../src/index.js";

/**
 * Review round 50: two pages never share a path or a document id, and a copy that can't be read
 * never makes its mirror skipped. Invented Forge pages.
 */

const NOW = "2026-11-01T09:00:00Z";

async function metarepo(wikis: string): Promise<{ root: string; base: string; op: OrgPack }> {
  const base = await mkdtemp(join(tmpdir(), "atticus-page-paths-"));
  const root = join(base, "root");
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeFile(
    join(root, "org-pack/sources.yaml"),
    `schemaVersion: 3\nwikis:\n${wikis.replaceAll("$BASE", base)}`,
  );
  const op = await loadOrgPack(join(root, "org-pack"));
  if (op.problems.length) throw new Error(JSON.stringify(op.problems));
  return { root, base, op };
}

const confluencePage = (title: string, body: string) =>
  `<html><head><title>ENG : ${title}</title></head><body><div id="main-content"><p>${body}</p></div></body></html>`;

describe("export page paths are unique within a source", () => {
  it("gives two Confluence titles with one path each their page id, and keeps a unique path", async () => {
    const { root, base, op } = await metarepo(
      "  - { id: cx, type: confluence-export, location: $BASE/cx }\n",
    );
    await mkdir(join(base, "cx"), { recursive: true });
    await writeFile(
      join(base, "cx/C-coding-standard_111.html"),
      confluencePage("C# coding standard", "Every C# service logs JSON to standard output."),
    );
    await writeFile(
      join(base, "cx/C-coding-standard_222.html"),
      confluencePage("C++ coding standard", "Every C++ service links the shared allocator."),
    );
    await writeFile(
      join(base, "cx/Logging_333.html"),
      confluencePage("Logging", "Every service logs in JSON with the trace id."),
    );
    const pages = await confluenceExportAdapter.pages(op.sources.wikis[0]!, {
      root,
      orgPackDir: join(root, "org-pack"),
    });
    expect(pages.map((p) => p.pagePath).sort()).toEqual([
      "C-coding-standard-111.md",
      "C-coding-standard-222.md",
      "Logging.md",
    ]);
    // Two runs give the same paths.
    const again = await confluenceExportAdapter.pages(op.sources.wikis[0]!, {
      root,
      orgPackDir: join(root, "org-pack"),
    });
    expect(again.map((p) => p.pagePath)).toEqual(pages.map((p) => p.pagePath));
  });

  it("keeps a SharePoint Markdown page's path and gives the others their extension", async () => {
    const { root, base, op } = await metarepo(
      "  - { id: sp, type: sharepoint-export, location: $BASE/sp }\n",
    );
    await mkdir(join(base, "sp"), { recursive: true });
    const html = (t: string) =>
      `<html><head><title>${t}</title></head><body><p>${t} body</p></body></html>`;
    await writeFile(join(base, "sp/refunds.aspx"), html("Refunds (aspx)"));
    await writeFile(join(base, "sp/refunds.html"), html("Refunds (html)"));
    await writeFile(join(base, "sp/refunds.markdown"), "# Refunds (markdown)\n\nBody.\n");
    await writeFile(join(base, "sp/refunds.md"), "# Refunds (md)\n\nBody.\n");
    await writeFile(join(base, "sp/vendors.aspx"), html("Vendors"));
    await writeFile(join(base, "sp/onboarding.aspx"), html("Onboarding (aspx)"));
    await writeFile(join(base, "sp/onboarding.html"), html("Onboarding (html)"));
    const pages = await sharepointExportAdapter.pages(op.sources.wikis[0]!, {
      root,
      orgPackDir: join(root, "org-pack"),
    });
    expect(pages.map((p) => p.pagePath).sort()).toEqual([
      "onboarding.aspx.md",
      "onboarding.html.md",
      "refunds.aspx.md",
      "refunds.html.md",
      "refunds.markdown.md",
      "refunds.md",
      "vendors.md",
    ]);
  });
});

describe("a snapshot lists each page once", () => {
  it("refuses a second page with a path already in the manifest, saying why", async () => {
    const { root, op } = await metarepo("  - { id: w, type: markdown-folder, location: ./w }\n");
    const twice: KnowledgeSourceAdapter = {
      pages: async () => [
        { pagePath: "retries.md", path: "w/a/retries.md", content: "# Retries\n\nRetry twice.\n" },
        { pagePath: "retries.md", path: "w/b/retries.md", content: "# Retries\n\nRetry once.\n" },
        { pagePath: "timeouts.md", path: "w/timeouts.md", content: "# Timeouts\n\nWait.\n" },
      ],
    };
    const sync = await syncSources({ root, orgPack: op, adaptersById: { w: twice }, now: NOW });
    await writeSnapshots({ root, orgPack: op, sync, takenAt: NOW });
    const manifest = parse(
      await readFile(join(root, "knowledge/snapshots/w/2026-11-01/snapshot.yaml"), "utf8"),
    ) as { pages: { page: string }[]; skipped: { page: string; reason: string }[] };
    expect(manifest.pages.map((p) => p.page)).toEqual(["retries.md", "timeouts.md"]);
    expect(manifest.skipped).toContainEqual({
      page: "w/b/retries.md",
      reason: "another page of the source has the path retries.md (w/a/retries.md), which is kept",
    });
    const snap = await readSnapshot(root, "w");
    expect(snap!.pages.find((p) => p.pagePath === "retries.md")!.text).toContain("Retry twice.");
  });
});

describe("document ids are unique", () => {
  it("gives pages whose names slug alike ids of their own, and keeps the plain one's", async () => {
    const { root, base, op } = await metarepo(
      "  - { id: w, type: markdown-folder, location: $BASE/w }\n",
    );
    await mkdir(join(base, "w"), { recursive: true });
    for (const [f, t] of [
      ["Retry Policy.md", "Retry twice on a timeout."],
      ["retry_policy.md", "Retry once on a timeout."],
      ["retry-policy.md", "Never retry a refund."],
      ["timeouts.md", "Wait thirty seconds."],
    ])
      await writeFile(join(base, "w", f!), `# Page\n\n${t}\n`);
    const sync = await syncSources({ root, orgPack: op, now: NOW });
    const ids = sync.documents.map((d) => d.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids).toContain("doc.w.retry-policy");
    expect(ids).toContain("doc.w.timeouts");
    const byPath = new Map(sync.pages.map((p, k) => [p.pagePath, sync.documents[k]!.id]));
    expect(byPath.get("retry-policy.md")).toBe("doc.w.retry-policy");
    expect(byPath.get("Retry Policy.md")).toMatch(/^doc\.w\.retry-policy-[0-9a-f]{8}$/);
    expect(byPath.get("retry_policy.md")).toMatch(/^doc\.w\.retry-policy-[0-9a-f]{8}$/);
    // The same pages give the same ids again.
    const again = await syncSources({ root, orgPack: op, now: NOW });
    expect(again.documents.map((d) => d.id)).toEqual(ids);
  });
});

describe("a mirrored page is read by a copy that can be read", () => {
  it("reads the team copy when the standard's copy is restricted", async () => {
    const { root, base, op } = await metarepo(
      "  - { id: std, type: markdown-folder, authority: standard, location: $BASE/std }\n  - { id: team, type: markdown-folder, location: $BASE/team }\n",
    );
    for (const d of ["std", "team"]) await mkdir(join(base, d), { recursive: true });
    const body =
      "# Idempotency\n\nEvery payment request carries an idempotency key that the gateway keeps for twenty four hours.\n";
    await writeFile(join(base, "std/idem.md"), `---\nrestricted: true\n---\n${body}`);
    await writeFile(join(base, "team/idempotency.md"), body);
    const s = await syncSources({ root, orgPack: op, now: NOW });
    expect(s.pages.map((p) => `${p.source}/${p.pagePath}`)).toEqual(["team/idempotency.md"]);
    expect(s.skipped.map((x) => x.source)).toEqual(["std"]);
    expect(s.skipped[0]!.reason).toMatch(/under view restrictions/);
  });

  it("still reads the more authoritative copy when both can be read", async () => {
    const { root, base, op } = await metarepo(
      "  - { id: std, type: markdown-folder, authority: standard, location: $BASE/std }\n  - { id: team, type: markdown-folder, location: $BASE/team }\n",
    );
    for (const d of ["std", "team"]) await mkdir(join(base, d), { recursive: true });
    const body =
      "# Idempotency\n\nEvery payment request carries an idempotency key that the gateway keeps for twenty four hours.\n";
    await writeFile(join(base, "std/idem.md"), body);
    await writeFile(join(base, "team/idempotency.md"), body);
    const s = await syncSources({ root, orgPack: op, now: NOW });
    expect(s.pages.map((p) => `${p.source}/${p.pagePath}`)).toEqual(["std/idem.md"]);
    expect(s.skipped[0]!.reason).toBe("the same page as std/idem.md, which reads it");
  });
});
