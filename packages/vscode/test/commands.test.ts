import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normaliseCatalog,
  answersFrom,
  requiredSwitches,
  briefPathFrom,
  buildArgv,
  changeTypesFrom,
  commandsFor,
  howToRun,
  lineOf,
  splitWords,
  matchCommand,
  optionsOf,
  pickList,
  type Catalog,
  type CatalogCommand,
} from "../src/commands";

/** A slice of `atticus commands --json` (ADR 0096). */
const catalog: Catalog = {
  areas: [
    { id: "repos", title: "Repos, scans and specs" },
    { id: "changes", title: "Changes, findings and questions" },
    { id: "plan", title: "Plans, tasks and work items" },
    { id: "start", title: "Set up and keep healthy" },
  ],
  commands: [
    {
      id: "spec draft",
      words: ["spec", "draft"],
      usage: "atticus spec draft <repo>",
      summary: "Your assistant writes the repo's flows",
      args: [{ name: "repo", kind: "repo", optional: false, many: false }],
      flags: [
        { name: "--attempts", value: "3", required: false },
        { name: "--resume", value: "run", required: false },
        { name: "--force", required: false },
        { name: "--mode", value: "m", required: false },
      ],
      area: "repos",
      runs: "ai",
    },
    {
      id: "spec check",
      words: ["spec", "check"],
      usage: "atticus spec check <repo> [--json]",
      summary: "Check the repo's flows",
      args: [{ name: "repo", kind: "repo", optional: false, many: false }],
      flags: [{ name: "--json", required: false }],
      area: "repos",
      runs: "local",
    },
    {
      id: "change new",
      words: ["change", "new"],
      usage: 'atticus change new "<title>"',
      summary: "Start a change from a template: --type <type>",
      args: [{ name: "title", kind: "text", optional: false, many: false }],
      flags: [{ name: "--type", value: "type", required: true }],
      area: "changes",
      runs: "local",
    },
    {
      id: "change status",
      words: ["change", "status"],
      usage: "atticus change status <id> [--json]",
      summary: "State, next step, what blocks it",
      args: [{ name: "id", kind: "change", optional: false, many: false }],
      flags: [{ name: "--json", required: false }],
      area: "changes",
      runs: "local",
    },
    {
      id: "ado sync",
      words: ["ado", "sync"],
      usage: "atticus ado sync <change>",
      summary: "Create or update work items (a dry run until you add --approve)",
      args: [{ name: "change", kind: "change", optional: false, many: false }],
      flags: [
        { name: "--approve", required: false },
        { name: "--epic", value: "id", required: false },
      ],
      area: "plan",
      runs: "shared",
      approve: "--approve",
    },
    {
      id: "ui",
      words: ["ui"],
      usage: "atticus ui [--port n] [--open]",
      summary: "Start the app",
      args: [],
      flags: [{ name: "--port", value: "n", required: false }],
      area: "start",
      runs: "serve",
    },
    {
      id: "intake add",
      words: ["intake", "add"],
      usage: "atticus intake add <files...>",
      summary: "Drop documents into inputs/inbox",
      args: [{ name: "files", kind: "path", optional: false, many: true }],
      flags: [],
      area: "knowledge",
      runs: "local",
    },
  ],
};
const cmd = (id: string) => catalog.commands.find((c) => c.id === id)!;

describe("every command, from the command line's own catalogue (ADR 0096)", () => {
  it("finds the command words someone types, the longest that fits, and what follows", () => {
    expect(matchCommand(catalog, "spec draft nadiengine")).toEqual({
      command: cmd("spec draft"),
      rest: ["nadiengine"],
    });
    expect(matchCommand(catalog, 'change new "Let members pin a message" --type feature')).toEqual({
      command: cmd("change new"),
      rest: ["Let members pin a message", "--type", "feature"],
    });
    expect(matchCommand(catalog, "spec")).toBeUndefined();
  });

  it("builds the arguments as the command line takes them", () => {
    expect(
      buildArgv(cmd("spec draft"), {
        args: ["nadiengine"],
        flags: { "--force": true, "--attempts": "2" },
      }),
    ).toEqual(["spec", "draft", "nadiengine", "--force", "--attempts", "2"]);
    expect(buildArgv(cmd("intake add"), { args: [["a.md", "b.drawio"]], flags: {} })).toEqual([
      "intake",
      "add",
      "a.md",
      "b.drawio",
    ]);
  });

  it("runs an AI step with Copilot, asks a person before a shared write, and keeps a server in a terminal", () => {
    expect(howToRun(cmd("spec draft"))).toEqual({ mode: "ai" });
    expect(howToRun(cmd("ado sync"))).toEqual({ mode: "approve", flag: "--approve" });
    expect(howToRun(cmd("ui"))).toEqual({ mode: "terminal" });
    expect(howToRun(cmd("spec check"))).toEqual({ mode: "run" });
  });

  it("offers the options a person may add, leaving out what the extension sets itself", () => {
    expect(optionsOf(cmd("spec draft")).map((f) => f.name)).toEqual(["--attempts", "--force"]);
    expect(optionsOf(cmd("ado sync")).map((f) => f.name)).toEqual(["--epic"]);
    expect(optionsOf(cmd("spec check")).map((f) => f.name)).toEqual([]);
  });

  it("lists every command by area, with what it does and how it runs", () => {
    const list = pickList(catalog);
    expect(list.filter((i) => i.separator).map((i) => i.label)).toEqual([
      "Repos, scans and specs",
      "Changes, findings and questions",
      "Plans, tasks and work items",
      "Set up and keep healthy",
      "Other",
    ]);
    expect(list.find((i) => i.id === "spec draft")).toMatchObject({
      label: "Your assistant writes the repo's flows",
      description: "spec draft <repo> · with Copilot",
    });
    expect(list.find((i) => i.id === "ado sync")!.description).toBe(
      "ado sync <change> · asks you before it writes",
    );
  });

  it("offers the commands that take a repo, or a change, for that item", () => {
    expect(commandsFor(catalog, "repo").map((c) => c.id)).toEqual(["spec draft", "spec check"]);
    expect(commandsFor(catalog, "change").map((c) => c.id)).toEqual(["change status", "ado sync"]);
  });
});

describe("starting a change", () => {
  it("reads the change types from org-pack/change-types.yaml", () => {
    expect(
      changeTypesFrom(
        [
          "schemaVersion: 1",
          "types:",
          "  - id: feature",
          "    name: A new feature",
          "    phases: [define, design]",
          "  - id: bug-fix",
          "  - id: config-change",
          "    name: 'A config change'",
        ].join("\n"),
      ),
    ).toEqual([
      { id: "feature", name: "A new feature" },
      { id: "bug-fix" },
      { id: "config-change", name: "A config change" },
    ]);
  });

  it("finds the brief to write in what change new prints", () => {
    expect(
      briefPathFrom(
        "Created let-members-pin-a-message (feature, from the feature template). It is in define.\nWrite the brief: openspec/changes/let-members-pin-a-message/brief.md\n",
      ),
    ).toBe("openspec/changes/let-members-pin-a-message/brief.md");
    expect(briefPathFrom("nothing")).toBeUndefined();
  });
});

describe("a command typed in the chat (@atticus /run)", () => {
  it("fills the arguments in order and reads the options, and says what is still missing", () => {
    expect(answersFrom(cmd("spec draft"), ["nadiengine", "--force", "--attempts", "2"])).toEqual({
      answers: { args: ["nadiengine"], flags: { "--force": true, "--attempts": "2" } },
      missing: [],
    });
    expect(answersFrom(cmd("change new"), ["Pin a message"])).toEqual({
      answers: { args: ["Pin a message"], flags: {} },
      missing: ["--type"],
    });
    expect(answersFrom(cmd("spec draft"), [])).toEqual({
      answers: { args: [], flags: {} },
      missing: ["repo"],
    });
    expect(answersFrom(cmd("intake add"), ["a.md", "b.md"]).answers.args).toEqual([
      ["a.md", "b.md"],
    ]);
  });
});

describe("a required switch", () => {
  it("is set, not asked for a value", () => {
    const resume: CatalogCommand = {
      id: "critic --resume",
      words: ["critic"],
      usage: "atticus critic <change> [--gate g] --resume",
      summary: "Read in the AI lens answers",
      args: [{ name: "change", kind: "change", optional: false, many: false }],
      flags: [
        { name: "--gate", value: "g", required: false },
        { name: "--resume", required: true },
      ],
      area: "changes",
      runs: "local",
    };
    expect(requiredSwitches(resume)).toEqual({ "--resume": true });
    expect(answersFrom(resume, ["add-note-tags"])).toEqual({
      answers: { args: ["add-note-tags"], flags: { "--resume": true } },
      missing: [],
    });
  });
});

describe("the command list, friendlier (ADR 0098)", () => {
  it("leads with what a command does and keeps the command beside it", () => {
    const item = pickList(catalog).find((i) => i.id === "spec draft")!;
    expect(item).toMatchObject({
      label: "Your assistant writes the repo's flows",
      description: "spec draft <repo> · with Copilot",
    });
  });

  it("leaves out the commands only Atticus's own developers use, unless asked", () => {
    const withDev: Catalog = {
      ...catalog,
      areas: [...catalog.areas, { id: "developer", title: "For Atticus's own quality" }],
      commands: [
        ...catalog.commands,
        {
          ...cmd("ui"),
          id: "bench run",
          words: ["bench", "run"],
          usage: "atticus bench run",
          area: "developer",
          runs: "local",
        },
      ],
    };
    expect(pickList(withDev).some((i) => i.id === "bench run")).toBe(false);
    expect(pickList(withDev, { developer: true }).some((i) => i.id === "bench run")).toBe(true);
  });
});

describe("the twelve commands first, the legacy ones after (ADR 0124 addendum D-cli)", () => {
  // `atticus commands --json` marks each command legacy or not.
  const top = (id: string, area: string, runs: CatalogCommand["runs"], summary: string) => ({
    ...cmd("ui"),
    id,
    words: id.split(" "),
    usage: `atticus ${id}`,
    summary,
    area,
    runs,
    legacy: false,
  });
  const marked: Catalog = {
    areas: [...catalog.areas, { id: "developer", title: "For Atticus's own quality" }],
    commands: [
      { ...cmd("spec draft"), legacy: true },
      { ...cmd("spec check"), legacy: true },
      { ...cmd("ado sync"), legacy: true },
      { ...cmd("intake add"), legacy: true },
      { ...cmd("ui"), legacy: false },
      { ...cmd("change status"), legacy: false },
      { ...cmd("change new"), legacy: false },
      top("map", "repos", "ai", "Your assistant reads a repo into facts"),
      top("init", "start", "local", "Start your team's metarepo"),
      top("legacy", "start", "local", "Every other command"),
      { ...top("bench run", "developer", "local", "Bench"), legacy: true },
    ],
  };
  const shape = (c: Catalog, o?: { developer?: boolean }) =>
    pickList(c, o).map((i) => (i.separator ? `# ${i.label}` : i.id));

  it("lists the twelve first, in the help's order, then each area's legacy commands under Legacy", () => {
    expect(shape(marked)).toEqual([
      "# The twelve commands",
      "init",
      "map",
      // Within one of the twelve, the catalogue's own order.
      "change status",
      "change new",
      "ui",
      "legacy",
      "# Legacy · Repos, scans and specs",
      "spec draft",
      "spec check",
      "# Legacy · Plans, tasks and work items",
      "ado sync",
      "# Legacy · Other",
      "intake add",
    ]);
    // Each item still says what it does first, the command and how it runs beside it.
    expect(pickList(marked).find((i) => i.id === "map")).toMatchObject({
      label: "Your assistant reads a repo into facts",
      description: "map · with Copilot",
    });
    // The developers' commands only when asked, under Legacy too.
    expect(shape(marked, { developer: true })).toContain("# Legacy · For Atticus's own quality");
    expect(shape(marked, { developer: true })).toContain("bench run");
  });

  it("orders a subset the same way (a change's commands)", () => {
    expect(shape({ ...marked, commands: commandsFor(marked, "change") })).toEqual([
      "# The twelve commands",
      "change status",
      "# Legacy · Plans, tasks and work items",
      "ado sync",
    ]);
  });

  it("lists by area as before when the command line doesn't mark them", () => {
    expect(shape(catalog)[0]).toBe("# Repos, scans and specs");
  });

  it("does so with the command line's own catalogue: the twelve, then every other command", () => {
    const bin = join(process.cwd(), "../cli/dist/bin.js");
    const real = normaliseCatalog(
      JSON.parse(
        execFileSync(process.execPath, [bin, "commands", "--json"], { encoding: "utf8" }),
      ) as Catalog,
    );
    const list = pickList(real, { developer: true });
    expect(list[0]).toMatchObject({ label: "The twelve commands", separator: true });
    expect(list[1]!.id).toBe("init");
    const firstLegacy = list.findIndex((i) => i.separator && i.label.startsWith("Legacy · "));
    const head = list.slice(1, firstLegacy);
    expect(head.every((i) => !i.separator)).toBe(true);
    const byId = new Map(real.commands.map((c) => [c.id, c]));
    expect(head.every((i) => byId.get(i.id!)!.legacy === false)).toBe(true);
    expect(list.slice(firstLegacy).every((i) => i.separator || byId.get(i.id!)!.legacy)).toBe(true);
    // Every command is offered once.
    expect(list.filter((i) => !i.separator)).toHaveLength(real.commands.length);
  });
});

describe("a next step's arguments as a line (WP4.2)", () => {
  it("reads back the same words, quoting one with a space", () => {
    const args = ["change", "new", "Let members pin a message", "--type", "feature"];
    expect(lineOf(args)).toBe('change new "Let members pin a message" --type feature');
    expect(splitWords(lineOf(args))).toEqual(args);
  });
});
