import { readFileSync } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { handleMcp, MCP_TOOLS, type McpRun } from "../src/mcp.js";
import { main } from "../src/main.js";

/**
 * ADR 0207 part 2: three more map tools for the personas. Who owns a thing (`owners`), who uses
 * it (`consumers_of`) and which archived change was like this one (`similar_changes`), each a
 * read-only command with --json, beside `conflicts`. Invented Forge names only.
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const MANIFEST = "org-pack/profiles/forge/repos.manifest.yaml";

const call = (name: string, args: Record<string, unknown>, run: McpRun) =>
  handleMcp(
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } },
    run,
    "1",
  ) as Promise<{ result: { content: { text: string }[]; isError?: boolean } }>;

const runIn =
  (root: string): McpRun =>
  async (argv) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      [...argv, "--root", root],
      { out: (l) => out.push(l), err: (l) => err.push(l) },
      { quiet: true },
    );
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

/**
 * The Forge estate, patched in the test (the field fixture's generator is another branch's): the
 * Reports system's owner taken off its System record; manifest repos nobody read, two of one
 * system with different owners (forge-vault, forge-vault-ui) and one of a system the catalog
 * owns (forge-ledger-batch); a repo read into facts with no component (forge-schemas); an open
 * change that plans forge-approvals-api; and the archived changes of fixtures/past-changes.
 */
async function estate(archive = true): Promise<string> {
  const root = join(await mkdtemp(join(tmpdir(), "atticus-map-tools-")), "meta");
  await cp(join(FIX, "forge/metarepo"), root, { recursive: true });
  for (const r of parse(readFileSync(join(FIX, "forge/expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const rec = r.kind === "System" && r.id === "reports" ? { ...r, owner: undefined } : r;
    const p = parseRecord({ schemaVersion: 1, status: "current", ...rec });
    if (!p.ok) continue;
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await appendFile(
    join(root, MANIFEST),
    [
      ["forge-vault", "team-vault", "vault"],
      ["forge-vault-ui", "team-vault-ui", "vault"],
      ["forge-ledger-batch", "team-batch", "ledger"],
      ["forge-schemas", "team-schemas", "schemas"],
    ]
      .map(
        ([id, owner, system]) =>
          `  - id: ${id}\n    url: https://git.example.com/forge/${id}.git\n    type: spring-boot\n    owner: ${owner}\n    system: ${system}\n`,
      )
      .join(""),
  );
  await mkdir(join(root, "facts"), { recursive: true });
  await writeFile(join(root, "facts/forge-schemas.jsonl"), "");
  const change = join(root, "openspec/changes/forge-approvals");
  await mkdir(change, { recursive: true });
  await writeFile(
    join(change, "change.yaml"),
    "schemaVersion: 1\nid: forge-approvals\ntitle: Approvals portal\ntype: quick\nstate: plan\nauthors: {}\ncreatedAt: 2026-11-19T05:00:00Z\ncreatedBy: pat\nhandoffs: []\nhistory:\n  - from: draft\n    to: plan\n    at: 2026-11-19T05:00:00Z\n    by: pat\n    reason: Created\nowners: {}\nsystems: []\ntouches:\n  dataStores: []\n  interfaces: []\n  records: []\n  repos: []\n  tables: []\n",
  );
  await writeFile(
    join(change, "tasks.md"),
    "# Tasks\n\n## forge-approvals-api\n\n- [ ] t1 Add the service\n",
  );
  if (archive)
    await cp(join(FIX, "past-changes"), join(root, "openspec/changes/archive"), {
      recursive: true,
      filter: (src) => !src.endsWith("README.md"),
    });
  return root;
}

const json = (r: { result: { content: { text: string }[] } }) =>
  JSON.parse(r.result.content[0]!.text) as Record<string, unknown>;

describe("three more map tools (ADR 0207 part 2)", () => {
  it("are read-only tools that run their commands with --json", async () => {
    const calls: string[][] = [];
    const fake: McpRun = async (argv) => {
      calls.push(argv);
      return { code: 0, out: "{}", err: "" };
    };
    await call("owners", { id: "ledger-api" }, fake);
    await call("consumers_of", { id: "topic.transfers-completed" }, fake);
    await call("similar_changes", { change: "add-transfer-limit" }, fake);
    await call("similar_changes", { text: "raise the daily limit" }, fake);
    expect(calls).toEqual([
      ["owners", "ledger-api", "--json"],
      ["impact", "topic.transfers-completed", "--receivers", "--json"],
      ["change", "similar", "--change", "add-transfer-limit", "--json"],
      ["change", "similar", "raise the daily limit", "--json"],
    ]);
    // Neither argument: refused as an error result, and nothing is run.
    const neither = await call("similar_changes", {}, fake);
    expect(neither.result.isError).toBe(true);
    expect(neither.result.content[0]!.text).toBe("similar_changes needs change or text.");
    // Both: refused too, never one silently dropped.
    const both = await call("similar_changes", { change: "a-change", text: "words" }, fake);
    expect(both.result.isError).toBe(true);
    expect(both.result.content[0]!.text).toBe("similar_changes takes change or text, not both.");
    expect(calls).toHaveLength(4);
    const names = MCP_TOOLS.map((t) => t.name);
    expect(names.indexOf("owners")).toBe(names.indexOf("conflicts") + 1);
    expect(names).toEqual(expect.arrayContaining(["consumers_of", "similar_changes"]));
  });

  describe("on the Forge estate", () => {
    let root = "";
    beforeAll(async () => {
      root = await estate();
    }, 60_000);

    it("owners: the owner and where it is said, with the record's id and its system's", async () => {
      const run = runIn(root);
      expect(json(await call("owners", { id: "ledger-api" }, run))).toEqual({
        id: "ledger-api",
        kind: "Component",
        system: "ledger",
        owner: "team-ledger",
        from: { system: "ledger" },
        read: true,
        said: "ledger-api is owned by team-ledger (the System record ledger).",
      });
      // A system is its own system.
      expect(json(await call("owners", { id: "portal" }, run))).toMatchObject({
        id: "portal",
        kind: "System",
        system: "portal",
        owner: "team-portal",
      });
      // The catalog's Reports system names no owner: the profile's word, with its file.
      expect(json(await call("owners", { id: "reports-job" }, run))).toMatchObject({
        id: "reports-job",
        system: "reports",
        owner: "team-reports",
        from: { file: "org-pack/profiles/forge/profile.yaml" },
      });
      // A repo read into the map, by its id.
      expect(json(await call("owners", { id: "forge-ledger" }, run))).toMatchObject({
        id: "forge-ledger",
        kind: "Repo",
        system: "ledger",
        owner: "team-ledger",
        read: true,
      });
      // A manifest repo nobody read still has its manifest's owner, said "not read".
      expect(json(await call("owners", { id: "forge-vault" }, run))).toEqual({
        id: "forge-vault",
        kind: "Repo",
        system: "vault",
        owner: "team-vault",
        from: { file: MANIFEST },
        read: false,
        said: `forge-vault is owned by team-vault (${MANIFEST}). It is not read into the map yet.`,
      });
      // A repo's own manifest row wins over a sibling's row of the same system, and over the
      // catalog's System record.
      expect(json(await call("owners", { id: "forge-vault-ui" }, run))).toMatchObject({
        system: "vault",
        owner: "team-vault-ui",
        from: { file: MANIFEST },
        read: false,
      });
      expect(json(await call("owners", { id: "forge-ledger-batch" }, run))).toMatchObject({
        system: "ledger",
        owner: "team-batch",
        from: { file: MANIFEST },
        read: false,
      });
      // Read with no component: records cite it, or its facts file is there.
      expect(json(await call("owners", { id: "forge-gateway" }, run))).toMatchObject({
        kind: "Repo",
        owner: "team-platform",
        read: true,
      });
      expect(json(await call("owners", { id: "forge-schemas" }, run))).toMatchObject({
        kind: "Repo",
        owner: "team-schemas",
        read: true,
      });
      // Nobody names one.
      expect(json(await call("owners", { id: "audit-svc" }, run))).toEqual({
        id: "audit-svc",
        kind: "Component",
        system: "audit",
        read: true,
        said: "audit-svc: no owner on record.",
      });
    }, 120_000);

    it("owners and consumers_of: an id the map lacks is an answer, not an error", async () => {
      const run = runIn(root);
      const said = async (name: string, id: string) => {
        const r = await call(name, { id }, run);
        expect(r.result.isError, `${name} ${id}`).toBeUndefined();
        return r.result.content[0]!.text;
      };
      for (const name of ["owners", "consumers_of"]) {
        expect(await said(name, "forge-portal")).toBe(
          "forge-portal is not in the map: planned or not read. Neither: no manifest lists forge-portal and no open change plans it. Did you mean forge-portal-ui?",
        );
        expect(await said(name, "forge-approvals-api")).toBe(
          "forge-approvals-api is not in the map: planned or not read. forge-approvals-api is planned by change forge-approvals.",
        );
      }
      // In the manifests and not read: consumers_of says so; owners gives the manifest's owner.
      expect(await said("consumers_of", "forge-vault")).toBe(
        "forge-vault is not in the map: planned or not read. forge-vault is in the manifests and hasn't been read (atticus map forge-vault).",
      );
      expect(JSON.parse(await said("owners", "forge-vault"))).toMatchObject({ read: false });
    }, 120_000);

    it('ask "who owns" answers what owners answers', async () => {
      const run = runIn(root);
      for (const id of ["ledger-api", "reports-job", "audit-svc", "forge-vault", "forge-ledger"]) {
        const asked = json(await call("ask", { question: `who owns ${id}` }, run));
        const { readAs, query, ...rest } = asked;
        expect(readAs).toMatch(/^Read as: the owner recorded for/);
        expect(query).toBe(id);
        expect(rest).toEqual(json(await call("owners", { id }, run)));
      }
    }, 120_000);

    it("consumers_of: a topic's receivers, an API's callers, each with its id and owner", async () => {
      const run = runIn(root);
      const topic = json(await call("consumers_of", { id: "topic.transfers-completed" }, run)) as {
        receivers: { id: string; kind: string; owner?: string }[];
        further: unknown[];
      };
      expect(topic.receivers).toContainEqual(
        expect.objectContaining({ id: "reports-job", kind: "Component", owner: "team-reports" }),
      );
      // By the topic's name, as ask reads it.
      const byName = json(await call("consumers_of", { id: "transfers.completed" }, run)) as {
        receivers: { id: string }[];
      };
      expect(byName.receivers.map((r) => r.id)).toContain("reports-job");
      // Only what the ADR names: the receivers, what lies past them, and the root.
      expect(Object.keys(topic).sort()).toEqual(["further", "receivers", "root"]);
      const api = json(await call("consumers_of", { id: "ledger-api" }, run)) as {
        receivers: { id: string; path: string[]; owner?: string }[];
      };
      expect(api.receivers.length).toBeGreaterThan(0);
      for (const r of api.receivers) {
        // root, the interface whose callee it is, the caller.
        expect(r.path).toHaveLength(3);
        expect(r.path[0]).toBe("ledger-api");
      }
      expect(api.receivers.map((r) => r.id)).toContain("portal-bff");
      // Nothing receives it: an empty answer, not an error.
      const none = await call("consumers_of", { id: "reports-job" }, run);
      expect(none.result.isError).toBeUndefined();
      expect(json(none).receivers).toEqual([]);
      const said = await runIn(root)(["impact", "reports-job", "--receivers"]);
      expect(said.out).toContain("Nothing in the map receives reports-job.");
    }, 120_000);

    it("similar_changes: the archived changes nearest, each with its folder, id and file", async () => {
      const run = runIn(root);
      const r = json(
        await call("similar_changes", { text: "raise the daily transfer limit" }, run),
      ) as { how: string; changes: { id: string; change: string; file: string }[] };
      expect(r.how).toBe("words");
      expect(r.changes[0]).toMatchObject({
        id: "2026-05-12-raise-transfer-limit",
        change: "raise-transfer-limit",
        file: expect.stringMatching(
          /^openspec\/changes\/archive\/2026-05-12-raise-transfer-limit\//,
        ),
      });
      const unknown = await call("similar_changes", { change: "nope" }, run);
      expect(unknown.result.isError).toBe(true);
      expect(unknown.result.content[0]!.text).toBe(
        "There is no change nope: atticus change list shows them.",
      );
    }, 120_000);
  });

  it("similar_changes with nothing archived is an answer", async () => {
    const root = await estate(false);
    const r = await call("similar_changes", { text: "raise the daily limit" }, runIn(root));
    expect(r.result.isError).toBeUndefined();
    expect(json(r).changes).toEqual([]);
  }, 120_000);

  it('owners: a map that couldn\'t be read is an error, never "not read"', async () => {
    const root = await estate(false);
    await writeFile(
      join(root, "catalog/generated/component/quillfeather.yaml"),
      "kind: Component\nid: [oops\n",
    );
    const r = await call("owners", { id: "forge-vault" }, runIn(root));
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0]!.text).toMatch(/couldn't be read whole[\s\S]*quillfeather\.yaml/);
  }, 120_000);

  it("owners: a metarepo with nothing read yet still gives a manifest repo's owner", async () => {
    // Review of PR #6 (N1): an empty map is no fault for a repo the manifests name.
    const root = await estate(false);
    await rm(join(root, "catalog/generated"), { recursive: true, force: true });
    const run = runIn(root);
    const r = await call("owners", { id: "forge-vault" }, run);
    expect(r.result.isError).toBeUndefined();
    expect(json(r)).toMatchObject({ id: "forge-vault", owner: "team-vault", read: false });
  }, 120_000);
});
