import { beforeAll, describe, expect, it } from "vitest";
import { AREAS, commandCatalog, parseHelp, type CommandInfo } from "../src/command-catalog.js";
import { main } from "../src/main.js";

const run = async (argv: string[]) => {
  const out: string[] = [];
  const code = await main(argv, { out: (l) => out.push(l), err: () => undefined });
  return { code, out: out.join("\n") };
};

/**
 * ADR 0096: every command the command line has, as data an editor can offer: its words, its
 * arguments and what kind each is, its options, its area, and how it runs. Built from the help
 * text itself, so a new command can't be left out.
 */

describe("the command catalogue (ADR 0096)", () => {
  let all: CommandInfo[] = [];
  let byId = new Map<string, CommandInfo>();
  beforeAll(async () => {
    all = commandCatalog((await run(["help", "--all"])).out);
    byId = new Map(all.map((c) => [c.id, c]));
  });

  it("holds every command in atticus --help, each in an area", async () => {
    const help = (await run(["help", "--all"])).out;
    const lines = help
      .split("\n")
      .filter((l) => /^ {2}atticus [a-z]/.test(l))
      .map((l) => l.trim());
    // The help's own lines and the --handoff note aren't commands to run.
    const commands = lines.filter((l) => !/^atticus (--help|--version|<step>)/.test(l));
    expect(all.length).toBe(commands.length);
    const missing = all.filter((c) => !AREAS.some((a) => a.id === c.area)).map((c) => c.id);
    expect(missing).toEqual([]);
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
  });

  it("reads an AI step: its argument kinds, its options, and that it runs with the assistant", () => {
    expect(byId.get("scan survey")).toMatchObject({
      words: ["scan", "survey"],
      args: [{ name: "repo", kind: "repo", optional: false, many: false }],
      runs: "ai",
      area: "repos",
    });
    const flags = byId.get("scan survey")!.flags.map((f) => [f.name, f.value ?? null, f.required]);
    expect(flags).toEqual([
      ["--attempts", "3", false],
      ["--force", null, false],
      // ADR 0112: the model's limit, which the whole prompt must fit.
      ["--max-tokens", "n", false],
    ]);
    for (const id of [
      "scan verify",
      "spec draft",
      "change feature",
      "change architecture",
      "plan stories",
    ])
      expect(byId.get(id)!.runs).toBe("ai");
    // The critic's AI lenses take --handoff, one at a time; reading answers in and the stats don't.
    expect(byId.get("critic")!.runs).toBe("ai");
    expect(byId.get("critic --resume")!.runs).toBe("local");
    expect(byId.get("critic stats")!.runs).toBe("local");
  });

  it("marks what writes to a shared system, and the flag a person adds to approve it", () => {
    expect(byId.get("ado sync")).toMatchObject({ runs: "shared", approve: "--approve" });
    expect(byId.get("change handoff")).toMatchObject({ runs: "shared", approve: "--approve" });
    expect(byId.get("digest")).toMatchObject({ runs: "shared", approve: "--send" });
    expect(byId.get("plan submit")!.runs).toBe("shared");
    // A required option is said as such: change new needs its type.
    expect(byId.get("change new")).toMatchObject({
      args: [{ name: "title", kind: "text" }],
      area: "changes",
    });
    expect(byId.get("change new")!.flags.find((f) => f.name === "--type")).toMatchObject({
      value: "type",
      required: true,
    });
  });

  it("knows what keeps running, and what each argument refers to", () => {
    expect(byId.get("ui")!.runs).toBe("serve");
    expect(byId.get("stub serve")!.runs).toBe("serve");
    expect(byId.get("questions answer")!.args[0]).toMatchObject({ name: "id", kind: "question" });
    expect(byId.get("change status")!.args[0]).toMatchObject({ kind: "change" });
    expect(byId.get("intake add")!.args[0]).toMatchObject({ kind: "path", many: true });
    expect(byId.get("estate lineage")!.args.map((a) => a.kind)).toEqual(["flow", "text"]);
    expect(byId.get("schema export")!.args[0]).toMatchObject({ kind: "path", optional: true });
  });

  it("joins an option written on the line below to its command", () => {
    const [c] = parseHelp(
      [
        "  atticus catalog validate <dir>       Check record files",
        "          [--fix]                      Rewrite files that aren't in canonical form",
      ].join("\n"),
    );
    expect(c!.flags).toEqual([
      { name: "--fix", required: false, summary: "Rewrite files that aren't in canonical form" },
    ]);
  });

  it("keeps options on the lines below optional, however many there are", () => {
    const [c] = parseHelp(
      [
        "  atticus scan [--no-drift]            Scan every repo",
        "          [--repos a,b]                Only these repos",
        "          [--full]                     Ignore the scan cache",
        "          [--dry-run]                  Show what would change; write nothing",
      ].join("\n"),
    );
    expect(c!.flags.map((f) => [f.name, f.required])).toEqual([
      ["--no-drift", false],
      ["--repos", false],
      ["--full", false],
      ["--dry-run", false],
    ]);
  });

  it("reads an option given instead of an argument (<folder> | --org) as not required", () => {
    expect(byId.get("repos discover")!.flags.find((f) => f.name === "--org")).toMatchObject({
      required: false,
      value: "org",
    });
    expect(byId.get("questions answer")!.flags.find((f) => f.name === "--option")!.required).toBe(
      true,
    );
  });

  it("gives the scan its own options, not scan review", () => {
    const flags = (id: string) => byId.get(id)!.flags.map((f) => f.name);
    expect(flags("scan")).toEqual(
      expect.arrayContaining(["--no-drift", "--repos", "--full", "--dry-run", "--warnings"]),
    );
    expect(flags("scan review")).not.toContain("--full");
    expect(byId.get("scan")!.flags.some((f) => f.required)).toBe(false);
    expect(byId.get("scan review")!.flags.some((f) => f.required)).toBe(false);
  });

  it("prints itself as JSON", async () => {
    const r = await run(["commands", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { areas: unknown[]; commands: { id: string }[] };
    expect(j.commands.map((c) => c.id)).toContain("change new");
    expect(j.areas.length).toBe(AREAS.length);
  });

  it("says what every command does, in words: none is left blank", () => {
    const blank = all.filter((c) => !c.summary).map((c) => c.usage);
    expect(blank).toEqual([]);
  });

  it("keeps a summary to its words: the options it lists are read as options, not shown in it", () => {
    expect(byId.get("scan survey")!.summary).toBe(
      "Your assistant reads the repo and drafts its scan settings (folders to leave out, path prefixes, client base URLs); checked against the code",
    );
    expect(byId.get("scan survey")!.flags.map((f) => f.name)).toEqual(
      expect.arrayContaining(["--attempts", "--force"]),
    );
    const shown = all.filter((c) => /\[--/.test(c.summary ?? "")).map((c) => c.id);
    expect(shown).toEqual([]);
  });

  it("reads a description written on the line under its command", () => {
    const [c] = parseHelp(
      [
        "  atticus conformance <path> --kind <catalog|org-pack|dialect|plugin|executor>",
        "                                       Check a catalog, org pack, dialect, plugin or executor against the spec",
        "          [--json]                     Print the result as JSON",
      ].join("\n"),
    );
    expect(c).toMatchObject({
      usage: "atticus conformance <path> --kind <catalog|org-pack|dialect|plugin|executor>",
      summary: "Check a catalog, org pack, dialect, plugin or executor against the spec",
    });
    expect(c!.flags.map((f) => f.name)).toEqual(["--kind", "--json"]);
  });

  it("keeps a usage to the command: the architecture stage's words are its summary", () => {
    expect(byId.get("change architecture")).toMatchObject({
      usage: "atticus change architecture <change>",
      summary: expect.stringMatching(/^The architecture stage: the target flows/),
    });
  });
});
