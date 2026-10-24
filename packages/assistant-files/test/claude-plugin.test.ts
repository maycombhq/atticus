import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  claudeCommandContent,
  claudeCodePluginFiles,
  stepCommands,
  zeroInstallCommands,
} from "../src/index.js";

/**
 * ADR 0104: the Claude Code plugin (plugins/atticus), built from the same commands the metarepo's
 * .claude/commands get, with a SessionStart hook that says the next step and the read-only
 * `atticus mcp` server. Committed, and checked here against what the generator makes.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const VERSION = JSON.parse(readFileSync(join(REPO, "packages/cli/package.json"), "utf8"))
  .version as string;
const files = claudeCodePluginFiles(VERSION);
const byPath = new Map(files.map((f) => [f.path, f.content]));

describe("the Claude Code plugin (ADR 0104)", () => {
  it("is named atticus, at the command line's version", () => {
    const p = JSON.parse(byPath.get(".claude-plugin/plugin.json")!);
    expect(p).toMatchObject({ name: "atticus", version: VERSION, license: "Apache-2.0" });
    expect(p.description).toMatch(/Atticus/);
  });

  it("has every step and catalog command, as the metarepo's .claude/commands have them", () => {
    const all = [
      ...zeroInstallCommands({ catalog: "catalog", openspec: "openspec" }),
      ...stepCommands(),
    ];
    for (const c of all) expect(byPath.get(`commands/${c.name}.md`)).toBe(claudeCommandContent(c));
    expect([...byPath.keys()].filter((p) => p.startsWith("commands/"))).toHaveLength(all.length);
    expect(byPath.has("commands/atticus-next.md")).toBe(true);
    expect(byPath.has("commands/atticus-needs.md")).toBe(true);
  });

  it("starts the read-only MCP server and the next-step hook from the plugin's own folder", () => {
    expect(JSON.parse(byPath.get(".mcp.json")!)).toEqual({
      mcpServers: {
        atticus: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/bin/atticus-mcp.mjs"] },
      },
    });
    const hooks = JSON.parse(byPath.get("hooks/hooks.json")!);
    expect(hooks.hooks.SessionStart[0].hooks[0]).toMatchObject({
      type: "command",
      command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"',
    });
  });

  it("is committed as the generator makes it, and listed in the repository's marketplace", () => {
    const stale = files.filter((f) => {
      const p = join(REPO, "plugins/atticus", f.path);
      return !existsSync(p) || readFileSync(p, "utf8").replace(/\r\n/g, "\n") !== f.content;
    });
    expect(
      stale.map((f) => f.path),
      "run: pnpm claude-plugin",
    ).toEqual([]);
    const m = JSON.parse(readFileSync(join(REPO, ".claude-plugin/marketplace.json"), "utf8"));
    // The listing icon, a square PNG of the glasses with the name below.
    expect(readFileSync(join(REPO, "plugins/atticus/.claude-plugin/icon.png"))).toEqual(
      readFileSync(join(REPO, "docs/brand/icon-512.png")),
    );
    expect(m.plugins).toEqual([
      expect.objectContaining({ name: "atticus", source: "./plugins/atticus" }),
    ]);
  });

  describe("the prompt and response history hooks (ADR 0110)", () => {
    const TRANSCRIPT = join(REPO, "fixtures/history/claude-transcript.jsonl");

    it("records each prompt and each reply with UserPromptSubmit and Stop", () => {
      const hooks = JSON.parse(byPath.get("hooks/hooks.json")!).hooks;
      expect(hooks.UserPromptSubmit[0].hooks[0]).toMatchObject({
        type: "command",
        command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/history.mjs" prompt',
      });
      expect(hooks.Stop[0].hooks[0]).toMatchObject({
        type: "command",
        command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/history.mjs" response',
      });
    });

    /** The hook, with a fake atticus that writes down what it was asked and what it was given. */
    const setUp = async (inMetarepo: boolean) => {
      const dir = await mkdtemp(join(tmpdir(), "atticus-history-hook-"));
      await writeFile(join(dir, "history.mjs"), byPath.get("hooks/history.mjs")!);
      const meta = join(dir, "meta");
      await mkdir(join(meta, inMetarepo ? "org-pack" : "src"), { recursive: true });
      const bin = join(dir, "fake-atticus.js");
      const log = join(dir, "calls.jsonl");
      await writeFile(
        bin,
        [
          'const { appendFileSync, readFileSync } = require("node:fs");',
          `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), text: readFileSync(0, "utf8") }) + "\\n");`,
          'console.log("Recorded h-20261023101500-a1b2c3 (prompt, 33 bytes).");',
        ].join("\n"),
      );
      const run = (kind: string, input: unknown) =>
        execFileSync(process.execPath, [join(dir, "history.mjs"), kind], {
          env: { ...process.env, CLAUDE_PROJECT_DIR: meta, ATTICUS_BIN: bin },
          input: JSON.stringify(input),
          encoding: "utf8",
        });
      const calls = () =>
        existsSync(log)
          ? readFileSync(log, "utf8")
              .trim()
              .split("\n")
              .map((l) => JSON.parse(l) as { argv: string[]; text: string })
          : [];
      return { meta, run, calls };
    };

    it.skipIf(process.platform !== "win32")(
      "never hands the Windows shell a metarepo path it would expand (%...%)",
      async () => {
        const dir = await mkdtemp(join(tmpdir(), "atticus-history-hook-"));
        await writeFile(join(dir, "history.mjs"), byPath.get("hooks/history.mjs")!);
        const meta = join(dir, "%USERNAME%-meta");
        await mkdir(join(meta, "org-pack"), { recursive: true });
        const bin = join(dir, "bin");
        await mkdir(bin);
        const log = join(dir, "called.txt");
        await writeFile(join(bin, "atticus.cmd"), `@echo called>> "${log}"\r\n`);
        const env = {
          ...process.env,
          CLAUDE_PROJECT_DIR: meta,
          PATH: `${bin};${process.env.PATH}`,
        };
        delete (env as Record<string, string | undefined>).ATTICUS_BIN;
        execFileSync(process.execPath, [join(dir, "history.mjs"), "prompt"], {
          env,
          input: JSON.stringify({ prompt: "/atticus-next", cwd: meta }),
          encoding: "utf8",
        });
        expect(existsSync(log)).toBe(false);
      },
    );

    it("records a prompt in a metarepo, and adds nothing to the conversation", async () => {
      const h = await setUp(true);
      const out = h.run("prompt", {
        session_id: "5f1d7c0e",
        transcript_path: TRANSCRIPT,
        cwd: h.meta,
        hook_event_name: "UserPromptSubmit",
        prompt: "/atticus-needs add-transfer-limit",
      });
      expect(out).toBe("");
      expect(h.calls()).toEqual([
        {
          argv: [
            "history",
            "add",
            "--surface",
            "claude-code",
            "--kind",
            "prompt",
            "--session",
            "5f1d7c0e",
            "--root",
            h.meta,
          ],
          text: "/atticus-needs add-transfer-limit",
        },
      ]);
    });

    it("records the reply: the transcript's last assistant message, every text of it", async () => {
      const h = await setUp(true);
      expect(
        h.run("response", {
          session_id: "5f1d7c0e",
          transcript_path: TRANSCRIPT,
          hook_event_name: "Stop",
          stop_hook_active: false,
        }),
      ).toBe("");
      const [c] = h.calls();
      expect(c!.argv.slice(0, 6)).toEqual([
        "history",
        "add",
        "--surface",
        "claude-code",
        "--kind",
        "response",
      ]);
      expect(c!.text).toBe(
        "Reading the change first.\n\nadd-transfer-limit needs a firewall rule to Northwind Pay and a Kafka topic for the refusals.",
      );
    });

    it("records nothing outside a metarepo, or when the input isn't what Claude Code sends", async () => {
      const outside = await setUp(false);
      outside.run("prompt", { session_id: "s", prompt: "Which repos call forge-ledger?" });
      expect(outside.calls()).toEqual([]);
      const inside = await setUp(true);
      expect(
        execFileSync(process.execPath, [join(inside.meta, "..", "history.mjs"), "prompt"], {
          env: { ...process.env, CLAUDE_PROJECT_DIR: inside.meta, ATTICUS_BIN: "missing.js" },
          input: "not json",
          encoding: "utf8",
        }),
      ).toBe("");
      inside.run("response", { session_id: "s", transcript_path: join(inside.meta, "none.jsonl") });
      expect(inside.calls()).toEqual([]);
    });
  });

  describe("the hook at the start of a session", () => {
    const hook = async () => {
      const dir = await mkdtemp(join(tmpdir(), "atticus-plugin-"));
      await writeFile(join(dir, "session-start.mjs"), byPath.get("hooks/session-start.mjs")!);
      return dir;
    };
    const runHook = (dir: string, project: string, bin?: string) =>
      execFileSync(process.execPath, [join(dir, "session-start.mjs")], {
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: project,
          ...(bin ? { ATTICUS_BIN: bin } : { ATTICUS_BIN: join(dir, "missing.js") }),
        },
        encoding: "utf8",
      });

    it("says nothing outside a metarepo", async () => {
      const dir = await hook();
      expect(runHook(dir, dir)).toBe("");
    });

    it("says the next step in a metarepo, as atticus next gives it", async () => {
      const dir = await hook();
      const meta = join(dir, "meta");
      await mkdir(join(meta, "org-pack"), { recursive: true });
      const bin = join(dir, "fake-atticus.js");
      await writeFile(
        bin,
        [
          "const w = process.argv[2];",
          'if (w === "next") console.log(JSON.stringify({ next: { step: "survey", command: "atticus scan survey forge-ledger", slash: "/atticus-survey forge-ledger", why: "forge-ledger has no scan settings yet." }, steps: [] }));',
          'else if (w === "waiting") console.log(JSON.stringify({ counts: { questions: 0, needs: 2, manualSteps: 1, findings: 0, knowledgeToVerify: 0 } }));',
        ].join("\n"),
      );
      expect(runHook(dir, join(meta, "org-pack"), bin)).toBe(
        "This is an Atticus metarepo. Next step: forge-ledger has no scan settings yet. Run /atticus-survey forge-ledger (or atticus scan survey forge-ledger). Waiting on you: 2 open needs, 1 manual step (the waiting_on_you tool lists them by change). The atticus MCP tools read its catalog, knowledge, changes, needs and model runs.\n",
      );
    });

    it("says how to get the command line when it doesn't answer", async () => {
      const dir = await hook();
      const meta = join(dir, "meta");
      await mkdir(join(meta, ".atticus", "org-pack"), { recursive: true });
      expect(runHook(dir, meta)).toMatch(
        /^This is an Atticus metarepo, but the atticus command line didn't answer\./,
      );
    });
  });
});
