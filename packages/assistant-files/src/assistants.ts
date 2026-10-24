import { stringify } from "yaml";
import type { AgentDefinition, AssistantId } from "@maycombhq/core";
import type { CommandDef } from "./commands.js";
import type { CommentStyle } from "./header.js";

/**
 * Each assistant's own files (ADR 0121): where its slash commands, instructions, skills and
 * agents go, and how it passes the person's words to a command. The command bodies are the same
 * for all; only `{{ARGS}}` and the file around them differ. The formats are those each tool
 * documents in October 2026: one that changes is one entry here, and the parity test says where.
 */

export interface SkillLike {
  id: string;
  name: string;
  description: string;
}

export interface AssistantFormat {
  /** The tool's name, for messages. */
  name: string;
  /** Where a person types a slash command, as `next` says it: "In Copilot Chat: /atticus-…". */
  typeIn: string;
  /** Its program on PATH, for doctor. */
  programs: string[];
  /** Where a slash command's file goes. */
  commandPath(name: string): string;
  /** A slash command's file. */
  command(c: CommandDef): string;
  /** The comment style of a command file's header. */
  commandStyle: CommentStyle;
  /** The instructions: a section of a file a person shares, or a file of Atticus's own. */
  instructions?: {
    path: string;
    mode: "file" | "section";
    content(section: string, commands: string[]): string;
  };
  /** A skill's file, where the tool reads skills. */
  skill?(s: SkillLike, body: string): { path: string; content: string };
  /** An agent's file, where the tool reads agents. */
  agent?(a: AgentDefinition, body: string): { path: string; content: string };
}

const fm = (data: Record<string, unknown>) =>
  `---\n${stringify(data, { lineWidth: 0 }).trimEnd()}\n---\n`;

/** The person's words, where a tool has no placeholder: the command reads as written. */
const AFTER = "<the words after the command>";

const body = (c: CommandDef, args: string) => c.body.replaceAll("{{ARGS}}", args).trimEnd();

/** A TOML string: a multi-line literal where it can be, else a basic string with escapes. */
function tomlString(text: string): string {
  if (!text.includes("'''")) return `'''\n${text}\n'''`;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** A slash command as Claude Code reads it: front matter, then the body with $ARGUMENTS. */
export function claudeCommandContent(c: CommandDef): string {
  return (
    fm({
      description: c.description,
      ...(c.argumentHint ? { "argument-hint": c.argumentHint } : {}),
    }) + `\n${body(c, "$ARGUMENTS")}\n`
  );
}

export const ASSISTANT_FORMATS: Record<AssistantId, AssistantFormat> = {
  "claude-code": {
    name: "Claude Code",
    typeIn: "Claude Code",
    programs: ["claude"],
    commandPath: (n) => `.claude/commands/${n}.md`,
    command: claudeCommandContent,
    commandStyle: "html",
    instructions: { path: "CLAUDE.md", mode: "section", content: (s) => s },
    skill: (s, b) => ({
      path: `.claude/skills/${s.id}/SKILL.md`,
      content: fm({ name: s.id, description: s.description }) + `\n# ${s.name}\n\n${b}`,
    }),
    agent: (a, b) => ({
      path: `.claude/agents/${a.id}.md`,
      content: fm({ name: a.id, description: a.description }) + `\n${b}\n`,
    }),
  },
  copilot: {
    name: "GitHub Copilot",
    typeIn: "Copilot Chat",
    programs: ["code", "idea", "idea64"],
    commandPath: (n) => `.github/prompts/${n}.prompt.md`,
    command: (c) =>
      fm({ description: c.description, agent: "agent" }) + `\n${body(c, "${input:args}")}\n`,
    commandStyle: "html",
    instructions: { path: ".github/copilot-instructions.md", mode: "section", content: (s) => s },
    skill: (s, b) => ({
      path: `.github/instructions/${s.id}.instructions.md`,
      content: fm({ description: s.description, applyTo: "**" }) + `\n# ${s.name}\n\n${b}`,
    }),
    agent: (a, b) => ({
      path: `.github/agents/${a.id}.agent.md`,
      content: fm({ name: a.id, description: a.description }) + `\n${b}\n`,
    }),
  },
  cursor: {
    name: "Cursor",
    typeIn: "Cursor's chat",
    programs: ["cursor"],
    commandPath: (n) => `.cursor/commands/${n}.md`,
    command: (c) => `# ${c.description}\n\n${body(c, AFTER)}\n`,
    commandStyle: "html",
    instructions: {
      path: ".cursor/rules/atticus.mdc",
      mode: "file",
      content: (s) =>
        fm({ description: "How Atticus works in this repo", alwaysApply: true }) + `\n${s}`,
    },
    skill: (s, b) => ({
      path: `.cursor/rules/${s.id}.mdc`,
      content: fm({ description: s.description, alwaysApply: false }) + `\n# ${s.name}\n\n${b}`,
    }),
  },
  "gemini-cli": {
    name: "Gemini CLI",
    typeIn: "Gemini CLI",
    programs: ["gemini"],
    commandPath: (n) => `.gemini/commands/${n}.toml`,
    command: (c) =>
      `description = ${JSON.stringify(c.description)}\nprompt = ${tomlString(body(c, "{{args}}"))}\n`,
    commandStyle: "hash",
    instructions: { path: "GEMINI.md", mode: "section", content: (s) => s },
  },
  windsurf: {
    name: "Windsurf",
    typeIn: "Windsurf's Cascade",
    programs: ["windsurf"],
    commandPath: (n) => `.windsurf/workflows/${n}.md`,
    command: (c) => fm({ description: c.description }) + `\n${body(c, AFTER)}\n`,
    commandStyle: "html",
    instructions: {
      path: ".windsurf/rules/atticus.md",
      mode: "file",
      content: (s) => fm({ trigger: "always_on" }) + `\n${s}`,
    },
  },
  "agents-md": {
    name: "a tool that reads AGENTS.md (Codex and others)",
    typeIn: "your assistant (it follows AGENTS.md)",
    programs: ["codex"],
    commandPath: (n) => `.atticus/prompts/${n}.md`,
    command: (c) => `# /${c.name}: ${c.description}\n\n${body(c, AFTER)}\n`,
    commandStyle: "html",
    instructions: {
      path: "AGENTS.md",
      mode: "section",
      // A tool with no slash commands of its own reads them here: each with the file to follow.
      content: (s, commands) =>
        [
          s.trimEnd(),
          "",
          "### When the person types a slash command",
          "",
          "Follow the file named beside it, with the words the person typed after the command:",
          "",
          ...commands.map((n) => `- \`/${n}\`: \`.atticus/prompts/${n}.md\``),
          "",
        ].join("\n"),
    },
  },
};
