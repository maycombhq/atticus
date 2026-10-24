import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ASSISTANTS, loadOrgPack } from "@maycombhq/core";
import {
  ASSISTANT_FORMATS,
  writeAssistantFiles,
  metarepoCommands,
  renderAssistantFiles,
  smokeCheck,
  type RenderedFile,
} from "../src/index.js";

/**
 * Any assistant (ADR 0121): the same slash commands, checks and instructions for every tool the
 * registry knows, each in the files that tool reads.
 */

const FORGE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/forge/metarepo/org-pack",
);

async function render(allowed: readonly string[]): Promise<RenderedFile[]> {
  const op = await loadOrgPack(FORGE);
  return renderAssistantFiles({
    orgPack: {
      ...op,
      runtime: {
        ...op.runtime,
        assistants: { allowed: [...allowed] as never, default: allowed[0] as never },
      },
    },
    commands: [],
    profile: { kind: "metarepo" },
  });
}

const file = (files: RenderedFile[], path: string) => files.find((f) => f.path === path);

describe("the assistant registry (ADR 0121)", () => {
  it("renders every assistant core knows, and only those", () => {
    expect(Object.keys(ASSISTANT_FORMATS).sort()).toEqual([...ASSISTANTS].sort());
  });

  it("gives each assistant every slash command, in its own files", async () => {
    const files = await render(ASSISTANTS);
    const names = metarepoCommands().map((c) => c.name);
    for (const id of ASSISTANTS) {
      const fmt = ASSISTANT_FORMATS[id];
      for (const n of names) expect(file(files, fmt.commandPath(n)), `${id} ${n}`).toBeDefined();
    }
  });

  it("passes the person's words the way each tool does", async () => {
    const files = await render(ASSISTANTS);
    const body = (p: string) => file(files, p)!.content;
    expect(body(".claude/commands/atticus-feature.md")).toContain(
      "atticus change feature $ARGUMENTS",
    );
    expect(body(".github/prompts/atticus-feature.prompt.md")).toContain(
      "atticus change feature ${input:args}",
    );
    expect(body(".gemini/commands/atticus-feature.toml")).toContain(
      "atticus change feature {{args}}",
    );
    for (const p of [
      ".cursor/commands/atticus-feature.md",
      ".windsurf/workflows/atticus-feature.md",
      ".atticus/prompts/atticus-feature.md",
    ]) {
      expect(body(p), p).toContain("atticus change feature <the words after the command>");
      expect(body(p), p).not.toContain("{{ARGS}}");
    }
  });

  it("writes Gemini CLI commands as TOML with a description and a prompt", async () => {
    const files = await render(["gemini-cli"]);
    const toml = file(files, ".gemini/commands/atticus-next.toml")!.content;
    expect(toml).toMatch(/^description = ".+"$/m);
    expect(toml).toMatch(/^prompt = '''\n[\s\S]+\n'''$/m);
  });

  it("gives each assistant its instructions, and lists the commands where a tool has none of its own", async () => {
    const files = await render(ASSISTANTS);
    expect(file(files, ".cursor/rules/atticus.mdc")!.content).toMatch(/alwaysApply: true/);
    expect(file(files, ".windsurf/rules/atticus.md")!.content).toMatch(/trigger: always_on/);
    expect(file(files, "GEMINI.md")).toMatchObject({ mode: "section" });
    const agents = file(files, "AGENTS.md")!;
    expect(agents.mode).toBe("section");
    expect(agents.content).toContain("`/atticus-feature`");
    expect(agents.content).toContain(".atticus/prompts/atticus-feature.md");
  });

  it("writes nothing for an assistant runtime.yaml doesn't allow", async () => {
    const files = await render(["cursor"]);
    expect(files.some((f) => f.path.startsWith(".github/"))).toBe(false);
    expect(files.some((f) => f.path.startsWith(".claude/") || f.path === "CLAUDE.md")).toBe(false);
    expect(files.some((f) => f.path.startsWith(".cursor/commands/"))).toBe(true);
  });

  it("passes the smoke checks for every assistant", async () => {
    const files = await render(ASSISTANTS);
    // As written: each file with its header, each section inside its markers.
    const dir = await mkdtemp(join(tmpdir(), "atticus-assistants-"));
    await writeAssistantFiles(dir, files);
    const written = await Promise.all(
      files.map(async (f) => ({
        path: f.path,
        content: await readFile(join(dir, f.path), "utf8"),
      })),
    );
    expect(smokeCheck(written)).toEqual([]);
  });
});
