import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { starterPersonaFiles } from "@maycombhq/assistant-files";
import { MCP_TOOLS } from "../src/mcp.js";
import { outputsOf, skillsWriteCommand, sourcesOf, splitFm } from "../src/skills-commands.js";

/**
 * ADR 0201, decision 7: an organisation's own persona keeps its tools and hand-offs in the files
 * written for Claude and Copilot, `skills write` writes or merges `.vscode/mcp.json`, and the
 * starter personas and the define-change skill go through it clean. Forge names only.
 */

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const metarepo = () => {
  const root = mkdtempSync(join(tmpdir(), "atticus-personas-"));
  temps.push(root);
  mkdirSync(join(root, "org-pack"), { recursive: true });
  writeFileSync(join(root, "org-pack/pack.yaml"), "schemaVersion: 1\nname: forge\n");
  return root;
};
const write = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

const ARCHITECT = `---
name: ledger-architect
description: Writes the ledger architect's section from the map.
role: architect
owns: Ledger architect
model: sonnet
tools:
  - read
  - search
  - edit
  - atticus/ask
  - atticus/impact
  - atticus/conflicts
  - atticus/teleport
  - Bash
  - Read
handoffs:
  - ledger-architect-naysayer
  - to: forge-qa
    label: "Next: QA"
    prompt: Write the QA section.
  - nobody-here
---
You write the Ledger architect section.
`;
const NAYSAYER = `---
name: ledger-architect-naysayer
description: Asks what the ledger architect got wrong.
tools: [read, atticus/impact]
handoffs: [{ to: ledger-architect }]
---
You ask.
`;
const QA = "---\nname: forge-qa\ndescription: Forge QA.\n---\nYou test.\n";

function withPersonas() {
  const root = metarepo();
  write(root, "org-pack/agents/ledger-architect.md", ARCHITECT);
  write(root, "org-pack/agents/ledger-architect-naysayer.md", NAYSAYER);
  write(root, "org-pack/agents/forge-qa.md", QA);
  return root;
}

describe("atticus skills write: a persona's tools and hand-offs (ADR 0201)", () => {
  it("writes them into the Claude and the Copilot file as the ADR's table says", async () => {
    const root = withPersonas();
    const w = io();
    expect(await skillsWriteCommand(root, {}, w.io)).toBe(0);

    const claude = splitFm(read(root, ".claude/agents/ledger-architect.md"));
    expect(claude.fm).toEqual({
      name: "ledger-architect",
      description: "Writes the ledger architect's section from the map.",
      // A key the table doesn't name is kept, as before.
      model: "sonnet",
      tools:
        "Read, Grep, Glob, Edit, Write, mcp__atticus__ask, mcp__atticus__impact, mcp__atticus__conflicts, Bash",
    });
    // role and owns are the loop's, not the assistant's; the hand-offs are the body's last line.
    expect(claude.body.trimEnd().split("\n").at(-1)).toBe(
      "When you are done, hand to: ledger-architect-naysayer, forge-qa.",
    );
    expect(claude.body).toContain("You write the Ledger architect section.");

    const copilot = splitFm(read(root, ".github/agents/ledger-architect.agent.md"));
    expect(copilot.fm).toEqual({
      name: "ledger-architect",
      description: "Writes the ledger architect's section from the map.",
      tools: ["read", "search", "edit", "atticus/ask", "atticus/impact", "atticus/conflicts"],
      handoffs: [
        {
          label: "Hand to ledger-architect-naysayer",
          agent: "ledger-architect-naysayer",
          send: false,
        },
        { label: "Next: QA", agent: "forge-qa", prompt: "Write the QA section.", send: false },
      ],
    });
    expect(copilot.body).not.toContain("When you are done, hand to");

    const nay = splitFm(read(root, ".github/agents/ledger-architect-naysayer.agent.md"));
    expect(nay.fm.tools).toEqual(["read", "atticus/impact"]);
    expect(nay.fm.handoffs).toEqual([
      { label: "Hand to ledger-architect", agent: "ledger-architect", send: false },
    ]);
    expect(splitFm(read(root, ".claude/agents/ledger-architect-naysayer.md")).fm.tools).toBe(
      "Read, mcp__atticus__impact",
    );
    // An agent that lists nothing is written as before: no tools key, so every tool.
    expect(splitFm(read(root, ".github/agents/forge-qa.agent.md")).fm).toEqual({
      name: "forge-qa",
      description: "Forge QA.",
    });

    // What was left out is said, by name.
    const said = w.out.join("\n");
    expect(said).toContain(
      "ledger-architect: left out atticus/teleport: atticus mcp serves no tool of that name",
    );
    expect(said).toContain(
      "ledger-architect: left out the hand-off to nobody-here: the org pack has no agent of that name",
    );
    expect(said).toContain(
      "ledger-architect: left out of the Copilot file: Bash (Copilot's agent file takes read, search, edit and atticus/<tool>)",
    );
  });

  it("--check detects a persona's source that moved on, and passes once written", async () => {
    const root = withPersonas();
    expect(await skillsWriteCommand(root, { check: true }, io().io)).toBe(1);
    await skillsWriteCommand(root, {}, io().io);
    expect(await skillsWriteCommand(root, { check: true }, io().io)).toBe(0);
    write(
      root,
      "org-pack/agents/ledger-architect-naysayer.md",
      NAYSAYER.replace("atticus/impact", "atticus/impact, atticus/walk"),
    );
    const c = io();
    expect(await skillsWriteCommand(root, { check: true }, c.io)).toBe(1);
    expect(c.out).toContain("behind: .claude/agents/ledger-architect-naysayer.md");
    expect(c.out).toContain("behind: .github/agents/ledger-architect-naysayer.agent.md");
  });

  it("another team's agent still reads only, whatever it lists (ADR 0177)", () => {
    const [claude, copilot] = outputsOf({
      kind: "agent",
      name: "harbor-architect",
      source: "org-pack/agents/imported/harbor/harbor-architect.md",
      team: "harbor",
      text: "---\ntools: [read, edit, atticus/ask, Bash]\nhandoffs: [forge-qa]\n---\nReview.\n",
      files: [],
    });
    expect(splitFm(claude!.text).fm.tools).toBe("Read, Grep, Glob");
    expect(splitFm(copilot!.text).fm).toEqual({
      name: "harbor-architect",
      description: "Review.",
      tools: ["read", "search"],
    });
    expect(claude!.text).not.toContain("hand to");
  });
});

describe("atticus skills write: the metarepo's .vscode/mcp.json (ADR 0201)", () => {
  const SERVER = { type: "stdio", command: "atticus", args: ["mcp"] };

  it("writes it when there is none, and --check says it is behind until then", async () => {
    const root = metarepo();
    const c = io();
    expect(await skillsWriteCommand(root, { check: true }, c.io)).toBe(1);
    expect(c.out).toContain("behind: .vscode/mcp.json (the atticus map tools)");
    const w = io();
    expect(await skillsWriteCommand(root, {}, w.io)).toBe(0);
    expect(w.out).toContain("wrote .vscode/mcp.json");
    expect(JSON.parse(read(root, ".vscode/mcp.json"))).toEqual({ servers: { atticus: SERVER } });
    expect(await skillsWriteCommand(root, { check: true }, io().io)).toBe(0);
  });

  it("adds the atticus server to a file that has others, and keeps everything else", async () => {
    const root = metarepo();
    const theirs = {
      inputs: [{ id: "forge-token", type: "promptString" }],
      servers: { "forge-wiki": { type: "http", url: "https://wiki.forge.example/mcp" } },
    };
    write(root, ".vscode/mcp.json", JSON.stringify(theirs, null, "\t") + "\n");
    const w = io();
    expect(await skillsWriteCommand(root, {}, w.io)).toBe(0);
    expect(w.out).toContain("added the atticus server to .vscode/mcp.json");
    const text = read(root, ".vscode/mcp.json");
    expect(JSON.parse(text)).toEqual({
      inputs: theirs.inputs,
      servers: { "forge-wiki": theirs.servers["forge-wiki"], atticus: SERVER },
    });
    // In the file's own indentation.
    expect(text).toContain('\n\t"servers"');
    expect(await skillsWriteCommand(root, { check: true }, io().io)).toBe(0);
  });

  it("leaves a file that has an atticus server, or doesn't read as JSON, exactly as it is", async () => {
    const own = metarepo();
    const mine =
      '{ "servers": { "atticus": { "command": "/opt/forge/bin/atticus", "args": ["mcp"] } } }';
    write(own, ".vscode/mcp.json", mine);
    const w = io();
    expect(await skillsWriteCommand(own, {}, w.io)).toBe(0);
    expect(read(own, ".vscode/mcp.json")).toBe(mine);
    expect(w.out.join("\n")).not.toContain("mcp.json");

    const odd = metarepo();
    const jsonc = '{\n  // our servers\n  "servers": {}\n}\n';
    write(odd, ".vscode/mcp.json", jsonc);
    const o = io();
    expect(await skillsWriteCommand(odd, {}, o.io)).toBe(0);
    expect(read(odd, ".vscode/mcp.json")).toBe(jsonc);
    expect(o.out.join("\n")).toContain(
      ".vscode/mcp.json doesn't read as JSON, so it is left as it is. Add the atticus server to its servers yourself:",
    );
    // Nothing Atticus can write, so nothing is behind.
    expect(await skillsWriteCommand(odd, { check: true }, io().io)).toBe(0);
  });
});

describe("the starter personas and the define-change skill (ADR 0201)", () => {
  const PERSONAS = [
    "product-owner",
    "application-architect",
    "domain-architect",
    "ux-analyst",
    "developer",
    "qa",
    "security",
  ];

  async function starterPack() {
    const root = metarepo();
    for (const f of await starterPersonaFiles()) write(root, `org-pack/${f.path}`, f.text);
    return root;
  }

  it("are 14 agents and one skill, each with the ADR's frontmatter", async () => {
    const files = await starterPersonaFiles();
    expect(files.map((f) => f.path)).toEqual(
      [
        ...PERSONAS.flatMap((p) => [`agents/${p}.md`, `agents/${p}-naysayer.md`]),
        "skills/define-change/SKILL.md",
      ].sort(),
    );
    const served = new Set(MCP_TOOLS.map((t) => t.name));
    const names = new Set(PERSONAS.flatMap((p) => [p, `${p}-naysayer`]));
    const owns = new Map<string, string>();
    for (const f of files.filter((x) => x.path.startsWith("agents/"))) {
      const name = f.path.slice("agents/".length, -".md".length);
      const { fm, body } = splitFm(f.text);
      expect(Object.keys(fm), name).toEqual([
        "name",
        "description",
        "role",
        "owns",
        "tools",
        "handoffs",
      ]);
      expect(fm.name).toBe(name);
      expect(String(fm.description).length, name).toBeGreaterThan(40);
      expect(String(fm.description), name).not.toContain("\n");
      owns.set(name, String(fm.owns));
      const tools = fm.tools as string[];
      expect(tools.slice(0, 3)).toEqual(["read", "search", "edit"]);
      for (const t of tools.slice(3)) {
        expect(t, name).toMatch(/^atticus\//);
        expect(served.has(t.slice("atticus/".length)), `${name}: ${t}`).toBe(true);
      }
      // Every persona can ask what a change reaches; none can run a command.
      expect(tools).toContain("atticus/impact");
      for (const h of fm.handoffs as { to: string; label: string; prompt: string }[]) {
        expect(names.has(h.to), `${name} hands to ${h.to}`).toBe(true);
        expect(h.label && h.prompt, name).toBeTruthy();
      }
      // The words every one of them must carry.
      expect(body, name).toMatch(/is not in the map: planned or not read/i);
      if (name.endsWith("-naysayer")) {
        expect(body, name).toContain("At most five a round");
        expect(body, name).toContain("(no evidence in the map: planned or not read)");
        expect(body, name).toContain(
          "| Question | Evidence | Asked by | Answered by | Answer | State |",
        );
        expect(body, name).toContain("Nothing trivial");
        expect(body, name).toContain(`Asked by is \`${name}\``);
      } else expect(body, name).toMatch(/Never invent a (system|repo|screen)/);
    }
    // A naysayer owns the table under its persona's heading, and hands back to it.
    for (const p of PERSONAS) {
      expect(owns.get(`${p}-naysayer`)).toBe(owns.get(p));
      const nay = splitFm(files.find((f) => f.path === `agents/${p}-naysayer.md`)!.text).fm;
      expect((nay.handoffs as { to: string }[])[0]!.to).toBe(p);
      const per = splitFm(files.find((f) => f.path === `agents/${p}.md`)!.text).fm;
      expect((per.handoffs as { to: string }[]).map((h) => h.to)).toEqual([`${p}-naysayer`]);
    }
    expect(new Set(PERSONAS.map((p) => owns.get(p))).size).toBe(PERSONAS.length);
    // The template says so in its first lines.
    for (const n of ["domain-architect", "domain-architect-naysayer"])
      expect(
        splitFm(files.find((f) => f.path === `agents/${n}.md`)!.text).body.trimStart(),
      ).toMatch(/^> \*\*This is a template\.\*\* Copy[\s\S]{0,200}payments-architect/);

    const skill = files.find((f) => f.path === "skills/define-change/SKILL.md")!;
    const s = splitFm(skill.text);
    expect(s.fm.name).toBe("define-change");
    // The order names every persona once, each before its naysayer.
    for (const p of PERSONAS) expect(s.body).toContain(`\`${p}\`, then \`${p}-naysayer\``);
    for (const words of [
      "| Question | Evidence | Asked by | Answered by | Answer | State |",
      "## Planned",
      "When the assistant has no hand-off",
      "atticus change new --from requirements.md --check",
      "atticus change new --from requirements.md\n",
      "## ADDED Requirements",
      "what it\n  changes in operation",
      "(after t1)",
      "[P]",
      "## forge-orders",
      "atticus change handoff <id> --approve",
    ])
      expect(s.body, words).toContain(words);
  });

  it("go through skills write clean in an org pack, and --check passes after", async () => {
    const root = await starterPack();
    expect((await sourcesOf(root)).length).toBe(15);
    const w = io();
    expect(await skillsWriteCommand(root, {}, w.io)).toBe(0);
    expect(w.err).toEqual([]);
    // Nothing of a starter is left out: every tool is served and every hand-off has its agent.
    expect(w.out.filter((l) => l.includes("left out"))).toEqual([]);
    for (const p of PERSONAS.flatMap((x) => [x, `${x}-naysayer`])) {
      const claude = splitFm(read(root, `.claude/agents/${p}.md`));
      expect(String(claude.fm.tools), p).toMatch(/^Read, Grep, Glob, Edit, Write, mcp__atticus__/);
      expect(claude.fm).not.toHaveProperty("role");
      expect(claude.fm).not.toHaveProperty("handoffs");
      expect(claude.body, p).toMatch(/When you are done, hand to: [a-z-]+(, [a-z-]+)?\.\n$/);
      const copilot = splitFm(read(root, `.github/agents/${p}.agent.md`)).fm as {
        tools: string[];
        handoffs: { agent: string; send: boolean; prompt: string }[];
      };
      expect(copilot.tools, p).toContain("atticus/impact");
      expect(copilot.handoffs.every((h) => h.send === false && h.prompt.length > 10)).toBe(true);
    }
    expect(existsSync(join(root, ".claude/skills/define-change/SKILL.md"))).toBe(true);
    expect(existsSync(join(root, ".github/prompts/define-change.prompt.md"))).toBe(true);
    expect(existsSync(join(root, ".vscode/mcp.json"))).toBe(true);
    const c = io();
    expect(await skillsWriteCommand(root, { check: true }, c.io)).toBe(0);
    expect(c.out).toEqual(["The skills, agents and instructions written are current."]);
  });
});
