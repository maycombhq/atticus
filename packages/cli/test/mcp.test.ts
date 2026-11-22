import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { handleMcp, MCP_TOOLS, serveMcp, type McpRun } from "../src/mcp.js";
import { main } from "../src/main.js";

/**
 * ADR 0104: `atticus mcp`, the MCP server the Claude Code plugin starts. Read-only tools over the
 * commands' own code, over stdio. It never writes: a person approves every write.
 */

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");

const fake =
  (calls: string[][]): McpRun =>
  async (argv) => {
    calls.push(argv);
    return { code: 0, out: `{"ran": ${JSON.stringify(argv.join(" "))}}`, err: "" };
  };

describe("atticus mcp (ADR 0104)", () => {
  it("answers the handshake with its tools capability and its version", async () => {
    const r = await handleMcp(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      fake([]),
      "1.2.3",
    );
    expect(r).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "atticus", version: "1.2.3" },
        instructions: expect.stringMatching(/read-only/),
      },
    });
    // A notification gets no answer.
    expect(
      await handleMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, fake([]), "1"),
    ).toBeUndefined();
  });

  it("lists read-only tools, each with what it does and the arguments it takes", async () => {
    const r = (await handleMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }, fake([]), "1")) as {
      result: {
        tools: {
          name: string;
          description: string;
          inputSchema: { type: string };
          annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
        }[];
      };
    };
    const names = r.result.tools.map((t) => t.name);
    expect(names).toEqual(MCP_TOOLS.map((t) => t.name));
    expect(names).toEqual(
      expect.arrayContaining([
        "next_step",
        "catalog_query",
        "knowledge_items",
        "change_needs",
        "change_map",
        "change_estimate",
        "change_conformance",
        "open_questions",
      ]),
    );
    for (const t of r.result.tools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe("object");
      // Said in the protocol too, so an assistant can call them without asking (ADR 0119).
      expect(t.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    }
  });

  it("runs a tool as its command, with --json, and gives back what it printed", async () => {
    const calls: string[][] = [];
    const r = await handleMcp(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "change_needs", arguments: { change: "add-transfer-limit" } },
      },
      fake(calls),
      "1",
    );
    expect(calls).toEqual([["needs", "--change", "add-transfer-limit", "--all", "--json"]]);
    expect(r).toMatchObject({
      id: 3,
      result: { content: [{ type: "text", text: expect.stringContaining("needs --change") }] },
    });
    expect((r as { result: { isError?: boolean } }).result.isError).toBeUndefined();
  });

  it("gives a task's context through atticus task context, read-only (ADR 0113)", async () => {
    const calls: string[][] = [];
    const call = (args: Record<string, unknown>) =>
      handleMcp(
        {
          jsonrpc: "2.0",
          id: 8,
          method: "tools/call",
          params: { name: "task_context", arguments: args },
        },
        fake(calls),
        "1",
      );
    await call({ change: "return-order-time", task: "1.1" });
    await call({ change: "return-order-time", task: "1.1", json: true });
    expect(calls).toEqual([
      ["task", "context", "return-order-time", "1.1", "--markdown"],
      ["task", "context", "return-order-time", "1.1", "--json"],
    ]);
    const missing = (await call({ change: "return-order-time" })) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    expect(missing.result.isError).toBe(true);
    expect(missing.result.content[0]!.text).toBe("task_context needs task.");
  });

  it("searches the index by words and meaning through atticus query --search (ADR 0107, 0116)", async () => {
    const calls: string[][] = [];
    const call = (args: Record<string, unknown>) =>
      handleMcp(
        {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "search", arguments: args },
        },
        fake(calls),
        "1",
      );
    await call({ text: "fraud screen" });
    await call({ text: "firewall", kind: "ProcessDefinition,WikiSection" });
    expect(calls).toEqual([
      ["query", "fraud screen", "--search", "--by", "both"],
      ["query", "firewall", "--search", "--kind", "ProcessDefinition,WikiSection", "--by", "both"],
    ]);
  });

  it("asks the catalog a plain question, and finds the knowledge items that answer one (WP3.5)", async () => {
    const calls: string[][] = [];
    const call = (name: string, args: Record<string, unknown>) =>
      handleMcp(
        { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name, arguments: args } },
        fake(calls),
        "1",
      );
    await call("ask", { question: "who calls ledger-api?" });
    await call("knowledge_ask", { question: "how do I get a firewall opened?" });
    expect(calls).toEqual([
      ["ask", "who calls ledger-api?", "--json"],
      [
        "query",
        "how do I get a firewall opened?",
        "--search",
        "--kind",
        "Pattern,ProcessDefinition,Decision,Party,Product",
        "--by",
        "both",
      ],
    ]);
    const tools = MCP_TOOLS.filter((t) => t.name === "ask" || t.name === "knowledge_ask");
    expect(tools).toHaveLength(2);
    expect(tools.find((t) => t.name === "knowledge_ask")!.description).toMatch(/only from/);
  });

  it("shows a record, walks its links and shows the code a fact cites (ADR 0107 addendum)", async () => {
    const calls: string[][] = [];
    const call = (name: string, args: Record<string, unknown>) =>
      handleMcp(
        { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name, arguments: args } },
        fake(calls),
        "1",
      );
    await call("show", { id: "forge-orders.place-order" });
    await call("walk", { id: "forge-orders.place-order", hops: "2", kind: "Endpoint" });
    await call("show_code", { id: "forge-orders.place-order#1" });
    expect(calls).toEqual([
      ["context", "show", "forge-orders.place-order"],
      ["context", "walk", "forge-orders.place-order", "--hops", "2", "--kind", "Endpoint"],
      ["context", "code", "forge-orders.place-order#1"],
    ]);
    expect(await call("walk", { id: "x", hops: "3" })).toMatchObject({ result: { isError: true } });
  });

  it("reads what waits, the open needs and the model runs through their commands (ADR 0106)", async () => {
    const calls: string[][] = [];
    const call = (name: string, args: Record<string, unknown>) =>
      handleMcp(
        { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name, arguments: args } },
        fake(calls),
        "1",
      );
    await call("waiting_on_you", {});
    await call("waiting_on_you", { group: "kind", filter: "northwind pay" });
    await call("open_needs", {});
    await call("open_needs", { change: "add-transfer-limit" });
    await call("model_runs", { change: "knowledge-scan" });
    await call("model_run", { run: "run-20261023034002-0001" });
    expect(calls).toEqual([
      ["waiting", "--group", "change", "--json"],
      ["waiting", "--group", "kind", "--filter", "northwind pay", "--json"],
      ["needs", "--json"],
      ["needs", "--change", "add-transfer-limit", "--json"],
      ["runs", "--change", "knowledge-scan", "--json"],
      ["runs", "show", "run-20261023034002-0001", "--json"],
    ]);
    const bad = await call("waiting_on_you", { group: "repo" });
    expect(bad).toMatchObject({
      result: { isError: true, content: [{ text: "group is change or kind." }] },
    });
  });

  it("reads the prompt history through atticus history, read-only (ADR 0110)", async () => {
    const calls: string[][] = [];
    const call = (args: Record<string, unknown>) =>
      handleMcp(
        {
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: { name: "prompt_history", arguments: args },
        },
        fake(calls),
        "1",
      );
    await call({});
    await call({ change: "add-transfer-limit", filter: "northwind pay", limit: "5" });
    await call({ session: "5f1d7c0e" });
    expect(calls).toEqual([
      ["history", "--json"],
      [
        "history",
        "--change",
        "add-transfer-limit",
        "--filter",
        "northwind pay",
        "--limit",
        "5",
        "--json",
      ],
      ["history", "--session", "5f1d7c0e", "--json"],
    ]);
    const bad = await call({ session: "--surface" });
    expect(calls).toHaveLength(3);
    expect(bad).toMatchObject({ result: { isError: true } });
  });

  it("refuses a value that would be read as an option, and a tool it hasn't", async () => {
    const calls: string[][] = [];
    const bad = await handleMcp(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "change_status", arguments: { change: "--force" } },
      },
      fake(calls),
      "1",
    );
    expect(calls).toEqual([]);
    expect(bad).toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringMatching(/change can't start with "-"/) }],
      },
    });
    const none = await handleMcp(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "change_draft", arguments: {} },
      },
      fake(calls),
      "1",
    );
    expect(none).toMatchObject({
      error: { code: -32602, message: expect.stringMatching(/no tool change_draft/) },
    });
    const missing = await handleMcp(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "catalog_query", arguments: {} },
      },
      fake(calls),
      "1",
    );
    expect(missing).toMatchObject({
      result: { isError: true, content: [{ text: "catalog_query needs query." }] },
    });
    expect(
      await handleMcp({ jsonrpc: "2.0", id: 7, method: "resources/list" }, fake(calls), "1"),
    ).toMatchObject({
      error: { code: -32601 },
    });
  });

  it("says when the command failed, with what it said", async () => {
    const r = await handleMcp(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "open_questions", arguments: {} },
      },
      async () => ({ code: 2, out: "", err: "Not a metarepo: no org-pack/ here." }),
      "1",
    );
    expect(r).toMatchObject({
      result: { isError: true, content: [{ text: "Not a metarepo: no org-pack/ here." }] },
    });
  });

  it("serves one JSON message per line on stdin and stdout, and never writes anything else", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const lines: string[] = [];
    stdout
      .setEncoding("utf8")
      .on("data", (d: string) => lines.push(...d.split("\n").filter(Boolean)));
    const done = serveMcp(stdin, stdout, fake([]), "1");
    stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    stdin.write("not json\n");
    stdin.end();
    await done;
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "That line isn't JSON." } },
    ]);
  });

  it("runs the real command in a metarepo: the next step, as atticus next --json prints it", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "atticus-mcp-")), "meta");
    await cp(join(FORGE, "metarepo"), root, { recursive: true });
    const run: McpRun = async (argv) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(
        [...argv, "--root", root],
        { out: (l) => out.push(l), err: (l) => err.push(l) },
        { quiet: true },
      );
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    const r = (await handleMcp(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "next_step", arguments: {} } },
      run,
      "1",
    )) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(r.result.isError).toBeUndefined();
    expect(JSON.parse(r.result.content[0]!.text)).toHaveProperty("steps");
  }, 60_000);

  it("searches the code the assistant chooses: grep, files and outline (ADR 0118)", async () => {
    const calls: string[][] = [];
    const call = (name: string, args: Record<string, unknown>, run: McpRun = fake(calls)) =>
      handleMcp(
        { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name, arguments: args } },
        run,
        "1",
      ) as Promise<{ result: { content: { text: string }[]; isError?: boolean } }>;
    await call("grep", {
      pattern: "@ForgeServiceBase",
      regex: true,
      ignore_case: true,
      repo: "forge-vault",
      paths: "src/**",
      limit: "5",
    });
    await call("files", { glob: "**/*.java" });
    await call("outline", { repo: "forge-vault", path: "README.md" });
    expect(calls).toEqual([
      [
        "context",
        "grep",
        "@ForgeServiceBase",
        "--regex",
        "--ignore-case",
        "--repo",
        "forge-vault",
        "--paths",
        "src/**",
        "--limit",
        "5",
      ],
      ["context", "files", "**/*.java"],
      ["context", "outline", "forge-vault", "README.md"],
    ]);
    // The real command, on a metarepo with the repo cloned.
    const root = await mkdtemp(join(tmpdir(), "atticus-mcp-grep-"));
    await cp(join(FORGE, "../code-search/repos/forge-vault"), join(root, "workspace/forge-vault"), {
      recursive: true,
    });
    const run: McpRun = async (argv) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(
        [...argv, "--root", root],
        { out: (l) => out.push(l), err: (l) => err.push(l) },
        { quiet: true },
      );
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    const grep = await call("grep", { pattern: "@ForgeServiceBase" }, run);
    expect(grep.result.isError).toBeUndefined();
    expect(grep.result.content[0]!.text).toContain(
      'forge-vault:src/main/java/forge/vault/VaultApplication.java:7: @ForgeServiceBase("/vault-api")',
    );
    const outline = await call(
      "outline",
      { repo: "forge-vault", path: "src/main/java/forge/vault/web/SecretController.java" },
      run,
    );
    expect(outline.result.content[0]!.text).toContain(
      '15:   @VaultRoute(path = "/rotate", verb = "POST")',
    );
  }, 120_000);
  describe("the map tools a persona asks (ADR 0201)", () => {
    const call = (name: string, args: Record<string, unknown>, run: McpRun) =>
      handleMcp(
        { jsonrpc: "2.0", id: 20, method: "tools/call", params: { name, arguments: args } },
        run,
        "1",
      ) as Promise<{ result: { content: { text: string }[]; isError?: boolean } }>;

    it("conflicts runs atticus change conflicts, and an overlap is an answer, never an error", async () => {
      const calls: string[][] = [];
      await call("conflicts", {}, fake(calls));
      await call("conflicts", { id: "forge-ledger" }, fake(calls));
      expect(calls).toEqual([
        ["change", "conflicts", "--json"],
        ["change", "conflicts", "--touching", "forge-ledger", "--json"],
      ]);
      const pairs = '[{"changes":["a","b"],"overlap":{"repos":["forge-ledger"]}}]';
      const overlap = await call("conflicts", {}, async () => ({ code: 1, out: pairs, err: "" }));
      expect(overlap.result.isError).toBeUndefined();
      expect(overlap.result.content[0]!.text).toBe(pairs);
      // Any other failure of the same tool is still an error, and so is exit 1 of another tool.
      const broken = await call("conflicts", {}, async () => ({
        code: 2,
        out: "",
        err: "Not a metarepo: no org-pack/ here.",
      }));
      expect(broken.result.isError).toBe(true);
      const other = await call("changes", {}, async () => ({ code: 1, out: "[]", err: "" }));
      expect(other.result.isError).toBe(true);
      expect(MCP_TOOLS.find((t) => t.name === "conflicts")!.description).toBe(
        "Where open changes already overlap: each pair of changes that touch the same systems, records or repos, with what they share; with an id, the pairs that overlap on it, then each open change whose tasks.md or target flows name it, with the file, line and heading or task (so a change not open yet still sees who has work there). changes, then show <change id>, gives every change's repos (atticus change conflicts).",
      );
    });

    it("impact, show and walk answer an id the map lacks with one sentence, not an error", async () => {
      const said = "forge-portal is not in the map: planned or not read.";
      for (const name of ["impact", "show", "walk"]) {
        const r = await call(name, { id: "forge-portal" }, async () => ({
          code: name === "impact" ? 1 : 2,
          out: "",
          err: said,
        }));
        expect(r.result.isError, name).toBeUndefined();
        expect(r.result.content[0]!.text).toBe(said);
        // Every other failure is an error result as before.
        const bad = await call(name, { id: "forge-portal" }, async () => ({
          code: 1,
          out: "",
          err: "The index couldn't be opened.",
        }));
        expect(bad.result.isError, name).toBe(true);
      }
      // A tool that names no map id keeps its failures.
      const explain = await call("explain", { id: "forge-portal" }, async () => ({
        code: 1,
        out: "",
        err: said,
      }));
      expect(explain.result.isError).toBe(true);
    });

    it('says a real fault as an error, never as "planned or not read" (review of b30/tools)', async () => {
      const real =
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
      // A folder that is no metarepo: nothing was read, so nothing can be said to be missing.
      const bare = await mkdtemp(join(tmpdir(), "atticus-mcp-bare-"));
      for (const name of ["impact", "show", "walk"]) {
        const r = await call(name, { id: "forge-portal" }, real(bare));
        expect(r.result.isError, name).toBe(true);
        expect(r.result.content[0]!.text, name).toMatch(/is not a metarepo/);
        expect(r.result.content[0]!.text, name).not.toMatch(/planned or not read/);
      }
      const QUESTION = { question: "who calls forge-portal?" };
      const askBare = await call("ask", QUESTION, real(bare));
      expect(askBare.result.isError).toBe(true);
      expect(askBare.result.content[0]!.text).toMatch(/is not a metarepo/);
      expect(askBare.result.content[0]!.text).not.toMatch(/planned or not read/);
      const noChanges = await call("conflicts", {}, real(bare));
      expect(noChanges.result.isError).toBe(true);
      expect(noChanges.result.content[0]!.text).toMatch(/is not a metarepo/);
      expect((await call("conflicts", { id: "forge-ledger" }, real(bare))).result.isError).toBe(
        true,
      );

      // A metarepo with no catalog yet: the map is empty, which is not "this id is planned".
      const empty = join(await mkdtemp(join(tmpdir(), "atticus-mcp-empty-")), "meta");
      await cp(join(FORGE, "metarepo"), empty, { recursive: true });
      for (const name of ["impact", "show", "walk"]) {
        const r = await call(name, { id: "forge-portal" }, real(empty));
        expect(r.result.isError, name).toBe(true);
        expect(r.result.content[0]!.text, name).toMatch(/The map holds no records/);
      }
      const askEmpty = await call("ask", QUESTION, real(empty));
      expect(askEmpty.result.isError).toBe(true);
      expect(askEmpty.result.content[0]!.text).toMatch(/The map holds no records/);
      expect(askEmpty.result.content[0]!.text).not.toMatch(/planned or not read/);
      // There, no open changes overlap, and that is an answer.
      const none = await call("conflicts", {}, real(empty));
      expect(none.result.isError).toBeUndefined();

      // A record file that doesn't read: the id asked for may be the one in it.
      const broken = join(await mkdtemp(join(tmpdir(), "atticus-mcp-broken-")), "meta");
      await cp(join(FORGE, "metarepo"), broken, { recursive: true });
      let compDir = "";
      for (const r of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
        string,
        unknown
      >[]) {
        const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
        if (!p.ok) continue;
        const f = join(broken, "catalog/generated", recordPath(p.record));
        if (p.record.kind === "Component") compDir = dirname(f);
        await mkdir(dirname(f), { recursive: true });
        await writeFile(f, serializeRecord(p.record));
      }
      await writeFile(join(compDir, "quillfeather.yaml"), "kind: Component\nid: [oops\n");
      // Twice: the second time the index is already built, and the file is still unread.
      for (const round of [1, 2])
        for (const name of ["impact", "show", "walk"]) {
          const r = await call(name, { id: "quillfeather" }, real(broken));
          expect(r.result.isError, `${name} ${round}`).toBe(true);
          expect(r.result.content[0]!.text, `${name} ${round}`).toMatch(
            /couldn't be read whole[\s\S]*quillfeather\.yaml/,
          );
        }
      const askBroken = await call("ask", QUESTION, real(broken));
      expect(askBroken.result.isError).toBe(true);
      expect(askBroken.result.content[0]!.text).toMatch(
        /couldn't be read whole[\s\S]*quillfeather\.yaml/,
      );
      expect(askBroken.result.content[0]!.text).not.toMatch(/planned or not read/);
      // A question that names what was read is still answered beside the broken file.
      const askHas = await call("ask", { question: "who calls ledger-api?" }, real(broken));
      expect(askHas.result.isError).toBeUndefined();
      // What was read is still answered.
      const has = await call("show", { id: "ledger-api" }, real(broken));
      expect(has.result.isError).toBeUndefined();
      expect(has.result.content[0]!.text).toMatch(/^Component ledger-api/);
    }, 180_000);

    it("on the Forge estate: the real commands' answers", async () => {
      const root = join(await mkdtemp(join(tmpdir(), "atticus-mcp-map-")), "meta");
      await cp(join(FORGE, "metarepo"), root, { recursive: true });
      for (const r of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
        string,
        unknown
      >[]) {
        const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
        if (!p.ok) continue;
        const f = join(root, "catalog/generated", recordPath(p.record));
        await mkdir(dirname(f), { recursive: true });
        await writeFile(f, serializeRecord(p.record));
      }
      const run: McpRun = async (argv) => {
        const out: string[] = [];
        const err: string[] = [];
        const code = await main(
          [...argv, "--root", root],
          { out: (l) => out.push(l), err: (l) => err.push(l) },
          { quiet: true },
        );
        return { code, out: out.join("\n"), err: err.join("\n") };
      };
      for (const name of ["impact", "show", "walk"]) {
        const r = await call(name, { id: "forge-portal" }, run);
        expect(r.result.isError, name).toBeUndefined();
        // The sentence, then which of the three it is (ADR 0201 addendum, 2026-11-19).
        expect(r.result.content[0]!.text).toBe(
          "forge-portal is not in the map: planned or not read. Neither: no manifest lists forge-portal and no open change plans it. Did you mean forge-portal-ui?",
        );
      }
      // The trial's question: ask got none where impact knew the consumer.
      const asked = await call(
        "ask",
        { question: "who consumes the topic transfers.completed?" },
        run,
      );
      expect(asked.result.isError).toBeUndefined();
      const a = JSON.parse(asked.result.content[0]!.text) as {
        readAs: string;
        query: string;
        affected: { id: string; kind: string }[];
      };
      expect(a.readAs).toBe(
        "Read as: who receives topic.transfers-completed: the receivers first, then what a change reaches past them.",
      );
      expect(a.query).toBe("impact topic.transfers-completed");
      const impact = await call("impact", { id: "topic.transfers-completed" }, run);
      expect(impact.result.content[0]!.text).toMatch(/reports-job/);
      expect(a.affected.map((x) => x.id)).toContain("reports-job");
      const none = await call("conflicts", { id: "forge-portal" }, run);
      expect(none.result.isError).toBeUndefined();
      expect(JSON.parse(none.result.content[0]!.text)).toEqual([]);
    }, 120_000);
  });
});
