import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { MockGitHost } from "@maycombhq/adapters";
import {
  changeArchive,
  changeConflicts,
  changeHandoff,
  changeList,
  changeNew,
  changeReturn,
  changeStatus,
  changeSync,
  parseOwners,
} from "../src/change-commands.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const CHANGE_FIXTURES = join(HERE, "../../changes/test/fixtures/add-transfer-limit");
const REPO = "forge/forge-metarepo";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

async function forgeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-cli-change-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  for (const r of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(String(r.id));
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await mkdir(join(root, ".github"), { recursive: true });
  await writeFile(join(root, ".github/CODEOWNERS"), "*  @forge/platform\n");
  return root;
}

const OWNERS = [
  "product-owner=pat",
  "architect=ari,avery",
  "team-lead=tia",
  "developer=dev,dee",
  "qa=quinn",
  "delivery-lead=dana",
  "sre=sam",
];

describe("atticus change", () => {
  it("creates, reports, hands off, syncs, lists, finds conflicts and returns a change", async () => {
    const root = await forgeRoot();
    const gh = new MockGitHost([{ repo: REPO }]);
    const deps = { gitHost: gh, now: "2026-10-19T09:00:00Z" };

    let c = capture();
    expect(await changeList(root, {}, c.io)).toBe(0);
    expect(c.out).toEqual(["No changes yet. Start one with atticus change new."]);

    c = capture();
    expect(await changeNew(root, { title: "Add transfer limit", type: "feature" }, c.io)).toBe(2);
    c = capture();
    expect(
      await changeNew(root, { title: "X", type: "vulnerability", by: "pat" }, c.io, deps),
    ).toBe(2);
    expect(c.err[0]).toBe(
      "Unknown change type vulnerability. Use one of: feature, integration, bug-fix, emergency-fix, config-change, tech-debt.",
    );

    c = capture();
    expect(
      await changeNew(
        root,
        {
          title: "Add transfer limit",
          type: "feature",
          by: "pat",
          owners: OWNERS,
          systems: ["ledger", "portal"],
        },
        c.io,
        deps,
      ),
    ).toBe(0);
    expect(c.out).toEqual([
      "Created add-transfer-limit (feature, from the feature template). It is in define.",
      "Write the brief: openspec/changes/add-transfer-limit/brief.md",
    ]);

    c = capture();
    expect(await changeStatus(root, "add-transfer-limit", {}, c.io)).toBe(0);
    expect(c.out).toEqual([
      "add-transfer-limit: Add transfer limit (feature)",
      "State: define",
      'Next: Finish the define work, then raise "Send to architecture".',
      "Risk: low (3): change type feature +2; 2 systems touched (ledger, portal) +1",
      "Approvals needed: product-owner (change type feature)",
      "Tests: unit, contract",
      "Privacy: no personal data touched.",
      "Blocked by:",
      "  - brief.md still holds only the template.",
      "  - proposal.md is missing.",
      "  - specs/<capability>/spec.md is missing.",
      '  - No hand-off PR yet: raise "Send to architecture" when the define work is done.',
    ]);

    c = capture();
    expect(await changeHandoff(root, "add-transfer-limit", {}, c.io, deps)).toBe(2);
    c = capture();
    expect(
      await changeHandoff(root, "add-transfer-limit", { by: "pat", repo: REPO }, c.io, deps),
    ).toBe(1);
    expect(c.err[0]).toBe('add-transfer-limit isn\'t ready for "Send to architecture".');
    expect(c.err).toHaveLength(4);

    await cp(join(CHANGE_FIXTURES, "define"), join(root, "openspec/changes/add-transfer-limit"), {
      recursive: true,
    });
    // runtime.yaml's mock Git host knows no repos, so without an injected host the PR can't open.
    c = capture();
    expect(
      await changeHandoff(root, "add-transfer-limit", { by: "pat", repo: REPO }, c.io, {}),
    ).toBe(1);
    expect(c.err[0]).toBe("git-host: repo forge/forge-metarepo not found");

    c = capture();
    expect(
      await changeHandoff(root, "add-transfer-limit", { by: "pat", repo: REPO }, c.io, deps),
    ).toBe(0);
    expect(c.out).toEqual([
      "Hand-off PR #1 (handoff/add-transfer-limit/define) is open: https://git.example.com/forge/forge-metarepo/pull/1",
      "Reviewers: @forge/platform",
    ]);
    expect(gh.journal.find((j) => j.method === "createPullRequest")!.approval).toEqual({
      by: "pat",
      at: "2026-10-19T09:00:00Z",
      scope: "once",
      ref: "handoff/add-transfer-limit/define",
    });

    c = capture();
    expect(await changeSync(root, "add-transfer-limit", { repo: REPO }, c.io, deps)).toBe(1);
    expect(c.err).toEqual([
      "PR #1 can't merge yet:",
      "  - Needs approval from product-owner (change type feature).",
    ]);
    gh.review(REPO, 1, "pat", "approved");
    c = capture();
    expect(await changeSync(root, "add-transfer-limit", { repo: REPO }, c.io, deps)).toBe(1);
    expect(c.out).toEqual(["Approvals are in on PR #1. Run again with --by <you> to merge it."]);
    c = capture();
    expect(
      await changeSync(root, "add-transfer-limit", { repo: REPO, by: "pat" }, c.io, deps),
    ).toBe(0);
    expect(c.out).toEqual(["PR #1 merged. add-transfer-limit is now design."]);

    c = capture();
    await changeNew(
      root,
      { title: "Show transfer history", type: "feature", by: "pat", systems: ["portal", "ledger"] },
      c.io,
      deps,
    );
    c = capture();
    expect(await changeList(root, {}, c.io)).toBe(0);
    expect(c.out).toEqual([
      "ID                     TYPE     STATE   HAND-OFF  TITLE",
      "add-transfer-limit     feature  design            Add transfer limit",
      "show-transfer-history  feature  define            Show transfer history",
    ]);
    c = capture();
    expect(await changeConflicts(root, {}, c.io)).toBe(1);
    expect(c.out).toEqual([
      "add-transfer-limit and show-transfer-history both touch systems ledger, portal",
    ]);

    await cp(join(CHANGE_FIXTURES, "design"), join(root, "openspec/changes/add-transfer-limit"), {
      recursive: true,
    });
    c = capture();
    expect(
      await changeHandoff(root, "add-transfer-limit", { by: "ari", repo: REPO }, c.io, deps),
    ).toBe(0);
    c = capture();
    expect(await changeStatus(root, "add-transfer-limit", { json: true }, c.io)).toBe(0);
    const status = JSON.parse(c.out.join("\n")) as {
      state: string;
      required: string[];
      risk: { level: string };
    };
    expect(status).toMatchObject({
      state: "design",
      required: ["architect (change type feature, gate design)"],
      risk: { level: "medium" },
    });

    c = capture();
    expect(await changeReturn(root, "add-transfer-limit", { by: "ari" }, c.io, deps)).toBe(2);
    c = capture();
    expect(
      await changeReturn(
        root,
        "add-transfer-limit",
        { by: "ari", reason: "Scope unclear", repo: REPO },
        c.io,
        deps,
      ),
    ).toBe(0);
    expect(c.out).toEqual([
      "Returned add-transfer-limit to the product owner. Close PR #2 on the Git host by hand; this Git host adapter can't close pull requests.",
    ]);

    c = capture();
    expect(await changeArchive(root, "add-transfer-limit", { by: "dana" }, c.io, deps)).toBe(1);
    expect(c.err[0]).toBe(
      "add-transfer-limit is returned; only a released change can be archived.",
    );

    c = capture();
    expect(await changeStatus(root, "nope", {}, c.io)).toBe(1);
  });

  it("parses --owner values", () => {
    expect(parseOwners(["architect=ari,avery", "qa=quinn", "architect=al"])).toEqual({
      architect: ["ari", "avery", "al"],
      qa: ["quinn"],
    });
    expect(parseOwners(["architect"])).toMatch(/^--owner takes role=person/);
  });
});

describe("change commands through main", () => {
  it("routes usage errors and reads repeated --owner and --system flags", async () => {
    const { main } = await import("../src/main.js");
    const err: string[] = [];
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
    expect(await main(["change", "status"], io)).toBe(2);
    expect(err.join("\n")).toMatch(/needs a change id/);
    expect(await main(["change", "new", "--root", "/nonexistent-atticus-root"], io)).toBe(2);
    expect(err.join("\n")).toMatch(/Usage: atticus change new/);
  });
});
