import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleMcp, MCP_TOOLS, type McpRun } from "../src/mcp.js";
import { main } from "../src/main.js";
import { FORGE_FIELD_ARCHIVED, seedForgeField, type ForgeField } from "./forge-field.js";

/**
 * ADR 0207 part 2: three more map tools beside conflicts, each a read-only command. owners (who
 * owns a record, a repo or a system, and where that is said), consumers_of (who receives a topic,
 * who calls an API or a component) and similar_changes (the archived changes nearest a change or
 * a text). An id the map lacks and "nothing found" are answers; every answer names record ids.
 * On the field-shaped Forge estate (CLAUDE.md rule 3); no network, no model (rule 5).
 */

const call = (name: string, args: Record<string, unknown>, run: McpRun) =>
  handleMcp(
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } },
    run,
    "1",
  ) as Promise<{ result: { content: { text: string }[]; isError?: boolean } }>;

const fake =
  (calls: string[][]): McpRun =>
  async (argv) => {
    calls.push(argv);
    return { code: 0, out: "{}", err: "" };
  };

describe("the three map tools of ADR 0207, as commands", () => {
  it("each runs its read-only command with --json", async () => {
    const calls: string[][] = [];
    await call("owners", { id: "forge-svc-02" }, fake(calls));
    await call("consumers_of", { id: "forge.items.settled" }, fake(calls));
    await call("similar_changes", { change: "publish-settled-refunds" }, fake(calls));
    await call("similar_changes", { text: "publish an event when a refund settles" }, fake(calls));
    expect(calls).toEqual([
      ["owners", "forge-svc-02", "--json"],
      ["impact", "forge.items.settled", "--receivers", "--json"],
      ["change", "similar", "--change", "publish-settled-refunds", "--json"],
      ["change", "similar", "publish an event when a refund settles", "--json"],
    ]);
    for (const name of ["owners", "consumers_of", "similar_changes"]) {
      const t = MCP_TOOLS.find((x) => x.name === name);
      expect(t, name).toBeDefined();
      expect(t!.description, name).toMatch(/\(atticus /);
    }
  });

  it("owners and consumers_of answer an id the map lacks with the sentence, not an error", async () => {
    const said = "forge-portal is not in the map: planned or not read.";
    for (const name of ["owners", "consumers_of"]) {
      const r = await call(name, { id: "forge-portal" }, async () => ({
        code: 1,
        out: "",
        err: said,
      }));
      expect(r.result.isError, name).toBeUndefined();
      expect(r.result.content[0]!.text).toBe(said);
      const broken = await call(name, { id: "forge-portal" }, async () => ({
        code: 1,
        out: "",
        err: "The catalog has no record yet: atticus map --all reads the estate.",
      }));
      expect(broken.result.isError, name).toBe(true);
    }
  });
});

describe("on the field-shaped Forge estate", () => {
  let tmp: string;
  let m: ForgeField & { root: string };
  const cli = async (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      [...argv, "--root", m.root],
      { out: (l) => out.push(l), err: (l) => err.push(l) },
      { quiet: true },
    );
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const run: McpRun = (argv) => cli(argv);
  const MANIFEST = "org-pack/profiles/github/repos.manifest.yaml";

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "atticus-map-tools-"));
    m = await seedForgeField(tmp);
    // A record nobody names an owner for. A manifest's repo always has an owner (the schema
    // requires one), so the case is a repo that left the manifest while its records are still
    // in the catalog: its entry, the manifest's last, is taken out after the build.
    const p = join(m.root, MANIFEST);
    const text = await readFile(p, "utf8");
    const at = text.indexOf("  - id: forge-nested-svc");
    expect(at).toBeGreaterThan(0);
    expect(text.slice(at).match(/^ {2}- id: /gm)).toHaveLength(1);
    await writeFile(p, text.slice(0, at), "utf8");
  }, 300_000);
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  it("owners: the owner, where it is said, and the record's id", async () => {
    const r = await call("owners", { id: "forge-svc-02" }, run);
    expect(r.result.isError).toBeUndefined();
    expect(JSON.parse(r.result.content[0]!.text)).toEqual({
      id: "forge-svc-02",
      kind: "Component",
      record: "Component/forge-svc-02",
      system: "forge-svc-02",
      read: true,
      owner: "team-forge",
      from: "manifest",
      file: MANIFEST,
    });
    // An entry of the repo answers its component's owner, with the entry's own record id.
    const entry = JSON.parse(
      (await cli(["owners", "forge-svc-01.post-dispute-5", "--json"])).out,
    ) as Record<string, unknown>;
    expect(entry).toMatchObject({
      id: "forge-svc-01.post-dispute-5",
      kind: "Endpoint",
      record: "Endpoint/forge-svc-01.post-dispute-5",
      owner: "team-forge",
      from: "manifest",
    });
    // In words.
    const said = await cli(["owners", "forge-svc-02"]);
    expect(said.code).toBe(0);
    expect(said.out).toBe(
      `forge-svc-02 (Component) is owned by team-forge, as ${MANIFEST} says of its repo.`,
    );
  });

  it("owners: a repo nobody read has its manifest's owner; one nobody names says so", async () => {
    const unread = await call("owners", { id: m.unreadRepo! }, run);
    expect(unread.result.isError).toBeUndefined();
    expect(JSON.parse(unread.result.content[0]!.text)).toEqual({
      id: m.unreadRepo,
      kind: "repo",
      read: false,
      owner: "team-forge",
      from: "manifest",
      file: MANIFEST,
    });
    expect((await cli(["owners", m.unreadRepo!])).out).toBe(
      `${m.unreadRepo} (a repo in the manifest, not read: atticus map ${m.unreadRepo}) is owned by team-forge, as ${MANIFEST} says.`,
    );
    const none = await cli(["owners", "forge-nested-svc"]);
    expect(none.code).toBe(0);
    expect(none.out).toMatch(/^forge-nested-svc \(Component\): no owner on record\./);
    const j = JSON.parse((await cli(["owners", "forge-nested-svc", "--json"])).out) as {
      owner?: string;
      record: string;
    };
    expect(j.owner).toBeUndefined();
    expect(j.record).toBe("Component/forge-nested-svc");
  });

  it("owners and consumers_of: an id the map lacks says which of the three it is", async () => {
    for (const name of ["owners", "consumers_of"]) {
      const r = await call(name, { id: "forge-portal" }, run);
      expect(r.result.isError, name).toBeUndefined();
      expect(r.result.content[0]!.text, name).toMatch(
        /^forge-portal is not in the map: planned or not read\. Neither: no manifest lists forge-portal/,
      );
    }
  });

  it('ask "who owns <id>" answers what owners answers', async () => {
    const asked = JSON.parse(
      (await call("ask", { question: "who owns forge-svc-02" }, run)).result.content[0]!.text,
    ) as Record<string, unknown>;
    const owners = JSON.parse(
      (await call("owners", { id: "forge-svc-02" }, run)).result.content[0]!.text,
    ) as Record<string, unknown>;
    expect(asked.readAs).toBe("Read as: the owner recorded for forge-svc-02.");
    const { readAs: _r, query: _q, ...answer } = asked;
    expect(answer).toEqual(owners);
  });

  it("consumers_of a topic: the components that receive it, each with its record and owner", async () => {
    const r = await call("consumers_of", { id: m.topic!.name }, run);
    expect(r.result.isError).toBeUndefined();
    const j = JSON.parse(r.result.content[0]!.text) as {
      id: string;
      kind: string;
      records: string[];
      consumers: { kind: string; id: string; owner?: string; why: string }[];
      further: number;
    };
    expect(j.id).toBe(m.topic!.name);
    expect(j.kind).toBe("topic");
    expect(j.records).toEqual(
      [...m.topic!.listeners!].sort().map((l) => `${l}.on-forge-items-settled`),
    );
    expect(j.consumers.map((c) => c.id).sort()).toEqual([...m.topic!.listeners!].sort());
    for (const c of j.consumers) {
      expect(c.kind).toBe("Component");
      expect(c.owner).toBe("team-forge");
      expect(c.why).toMatch(/receives forge\.items\.settled/);
    }
    expect(j.further).toBeGreaterThan(0);
    const said = await cli(["impact", m.topic!.name, "--receivers"]);
    expect(said.code).toBe(0);
    expect(said.out).toMatch(/^forge\.items\.settled is received by 2 components:/);
  });

  it("consumers_of an API and a component: the callers, each with the interface that says so", async () => {
    const api = JSON.parse(
      (await call("consumers_of", { id: "forge-svc-01.post-dispute-5" }, run)).result.content[0]!
        .text,
    ) as { kind: string; consumers: { id: string; via: string; owner?: string }[] };
    expect(api.kind).toBe("api");
    expect(api.consumers.length).toBeGreaterThan(0);
    for (const c of api.consumers) expect(c.via).toMatch(/^if-/);
    expect(api.consumers.map((c) => c.id)).toContain("forge-svc-02");
    const comp = JSON.parse(
      (await call("consumers_of", { id: "forge-svc-01" }, run)).result.content[0]!.text,
    ) as { kind: string; consumers: { id: string; via: string }[] };
    expect(comp.kind).toBe("component");
    expect(comp.consumers.length).toBeGreaterThanOrEqual(api.consumers.length);
    // Nothing found is an answer.
    const none = await cli(["impact", "forge-nosystem-svc-db", "--receivers"]);
    if (none.code === 0) expect(none.out).toMatch(/Nothing in the map (receives|calls)/);
  });

  it("similar_changes: the archived changes nearest a change or a text, each with its folder and file", async () => {
    for (const args of [
      { change: m.change },
      { text: "publish an event when a refund is requested" },
    ]) {
      const r = await call("similar_changes", args, run);
      expect(r.result.isError, JSON.stringify(args)).toBeUndefined();
      const j = JSON.parse(r.result.content[0]!.text) as {
        how: string;
        changes: { id: string; change: string; file: string }[];
      };
      expect(["meaning", "words"]).toContain(j.how);
      expect(j.changes[0]).toMatchObject({
        id: FORGE_FIELD_ARCHIVED.folder,
        change: FORGE_FIELD_ARCHIVED.id,
        file: `openspec/changes/archive/${FORGE_FIELD_ARCHIVED.folder}/proposal.md`,
      });
    }
    // A change that is none, and neither argument, are errors that say what to do.
    const unknown = await call("similar_changes", { change: "no-such-change" }, run);
    expect(unknown.result.isError).toBe(true);
    expect(unknown.result.content[0]!.text).toBe(
      "There is no change no-such-change: atticus change list shows them.",
    );
    const neither = await call("similar_changes", {}, run);
    expect(neither.result.isError).toBe(true);
    expect(neither.result.content[0]!.text).toMatch(/Say what the change is about/);
  });

  it("similar_changes: no archived change near is an answer", async () => {
    await rm(join(m.root, "openspec/changes/archive", FORGE_FIELD_ARCHIVED.folder), {
      recursive: true,
      force: true,
    });
    const r = await call("similar_changes", { change: m.change }, run);
    expect(r.result.isError).toBeUndefined();
    expect(JSON.parse(r.result.content[0]!.text)).toMatchObject({ changes: [] });
  });
});
