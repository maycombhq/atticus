import { describe, expect, it } from "vitest";
import { presetFrom, type CatalogCommand } from "../src/commands";
import {
  absorbConfirm,
  acceptConfirm,
  defaultAbsorbId,
  guidedCommand,
  guidedFor,
  onboardingStages,
  setupAction,
  setupProgress,
  type SetupStep,
} from "../src/guided";
import { questionLabel, stepTitle } from "../src/words";

/**
 * ADR 0100: everything from the plugin, guided. A step with a part to fill in opens the screen
 * that asks for it; the setup checklist and a repo's onboarding are lists to click through;
 * bringing in another team's repo is a dry run, a yes, a proposal, then an accept.
 */

describe("a next step with a part to fill in", () => {
  it("opens the guided screen for the command it names", () => {
    expect(guidedFor('atticus repos discover "<folder>"')).toBe("addRepos");
    expect(guidedFor("atticus repos discover <folder> --platform forge")).toBe("addRepos");
    expect(guidedFor('atticus change new "<title>" --type feature')).toBe("newChange");
    expect(guidedFor("atticus absorb <git-url|path> --id <id>")).toBe("absorb");
    expect(guidedFor("atticus absorb accept <id>")).toBe("absorbAccept");
    expect(guidedFor("atticus init <folder> --platform <p>")).toBe("createMetarepo");
    expect(guidedFor("atticus adopt <path>")).toBe("adoptRepo");
    expect(guidedFor("atticus spec draft <repo>")).toBeUndefined();
  });

  it("asks for the rest through the command's own pickers, keeping what is given", () => {
    const cmd: CatalogCommand = {
      id: "spec draft",
      words: ["spec", "draft"],
      usage: "atticus spec draft <repo>",
      summary: "Your assistant writes the repo's flows",
      args: [{ name: "repo", kind: "repo", optional: false, many: false }],
      flags: [
        { name: "--attempts", value: "3", required: false },
        { name: "--mode", value: "m", required: false },
      ],
      area: "repos",
      runs: "ai",
    };
    expect(presetFrom(cmd, ["<repo>", "--attempts", "3", "--mode", "<m>"])).toEqual({
      args: [undefined],
      flags: { "--attempts": "3" },
    });
    expect(presetFrom(cmd, ["nadiengine"])).toEqual({ args: ["nadiengine"], flags: {} });
  });
});

const steps = (done: Record<string, boolean>): SetupStep[] =>
  ["machine", "org-pack", "org-pack-owner", "repos", "clones", "scan", "knowledge", "baseline"].map(
    (id) => ({
      id,
      label: id,
      done: done[id] ?? false,
      fix: `fix ${id}`,
      ...(id === "knowledge" ? { optional: true } : {}),
    }),
  );

describe("the setup checklist", () => {
  it("counts the steps that must be done, and names the first one left", () => {
    const p = setupProgress(steps({ machine: true, "org-pack": true }));
    expect(p).toMatchObject({ done: 2, total: 7, complete: false });
    // atticus init leaves the org pack with owner: unassigned: naming one comes next.
    expect(p.next!.id).toBe("org-pack-owner");
    const all = setupProgress(
      steps({
        machine: true,
        "org-pack": true,
        "org-pack-owner": true,
        repos: true,
        clones: true,
        scan: true,
        baseline: true,
      }),
    );
    expect(all).toMatchObject({ done: 7, total: 7, complete: true });
    expect(all.next).toBeUndefined();
  });

  it("opens what fixes each step", () => {
    expect(setupAction("machine")).toEqual({ command: "atticus.checkHealth" });
    expect(setupAction("org-pack")).toEqual({
      command: "atticus.runCommand",
      args: ["orgpack validate"],
    });
    expect(setupAction("org-pack-owner")).toEqual({ command: "atticus.openOrgPackOwner" });
    expect(setupAction("repos")).toEqual({ command: "atticus.addRepos" });
    expect(setupAction("clones")).toEqual({ command: "atticus.workspaceSync" });
    expect(setupAction("scan")).toEqual({ command: "atticus.scanAll" });
    expect(setupAction("knowledge")).toEqual({ command: "atticus.addKnowledge" });
    expect(setupAction("baseline")).toEqual({ command: "atticus.acceptCatalog" });
    expect(setupAction("something-new")).toEqual({
      command: "atticus.runCommand",
      args: ["setup"],
    });
  });
});

const repo = (o: Partial<{ cloned: boolean; settings: boolean; records: number }> = {}) => ({
  id: "forge-web",
  cloned: o.cloned ?? false,
  scanSettings: { present: o.settings ?? false },
  lastScan: o.records === undefined ? null : { records: o.records },
});

describe("onboarding a repo", () => {
  it("lists the stages in order, the first one not done marked next", () => {
    const s = onboardingStages(repo(), { flows: 0, questions: 0 });
    expect(s.map((x) => [x.id, x.state])).toEqual([
      ["clone", "next"],
      ["survey", "todo"],
      ["scan", "todo"],
      ["verify", "todo"],
      ["spec", "todo"],
      ["dialect", "optional"],
    ]);
    expect(s[0]!.run).toEqual({
      kind: "cli",
      id: "workspace sync",
      args: [],
      flags: { "--repos": "forge-web" },
    });
    expect(s[1]!.run).toEqual({ kind: "cli", id: "scan survey", args: ["forge-web"], flags: {} });
    expect(s[2]!.run).toEqual({
      kind: "cli",
      id: "scan",
      args: [],
      flags: { "--repos": "forge-web" },
    });
  });

  it("checks the scan again after every scan, and asks a repo's questions", () => {
    const s = onboardingStages(repo({ cloned: true, settings: true, records: 120 }), {
      flows: 4,
      questions: 2,
    });
    expect(s.map((x) => [x.id, x.state])).toEqual([
      ["clone", "done"],
      ["survey", "done"],
      ["scan", "done"],
      ["verify", "again"],
      ["spec", "done"],
      ["questions", "next"],
      ["dialect", "optional"],
    ]);
    expect(s.find((x) => x.id === "questions")!).toMatchObject({
      label: "Answer its 2 open questions",
      run: { kind: "vscode", command: "atticus.answerRepo" },
    });
    expect(s.find((x) => x.id === "scan")!.detail).toContain("120 records");
  });
});

describe("bringing in another team's repo", () => {
  it("names it after its folder or repository", () => {
    expect(defaultAbsorbId("C:\\work\\Payments-Meta")).toBe("payments-meta");
    expect(defaultAbsorbId("https://git.example.com/team/pricing_spec.git")).toBe("pricing-spec");
    expect(defaultAbsorbId("../review prompts/")).toBe("review-prompts");
  });

  it("says what the dry run found, in plain words, before anything is written", () => {
    const c = absorbConfirm({
      id: "pricing",
      format: "plain",
      summary: {
        items: 5,
        translatedPercent: 100,
        byAction: { adopt: 0, link: 3, ignore: 2 },
        byKind: { typespec: 2, schema: 1, doc: 1, code: 1 },
      },
      problems: [],
    });
    expect(c.message).toBe(
      "Bring in pricing, a TypeSpec repo? 5 items: 0 to copy into the org pack, 3 to follow, 2 left out.",
    );
    expect(c.detail).toContain("2 TypeSpec files, kept as references");
    expect(c.detail).toContain("Nothing changes in the org pack yet");
    const meta = absorbConfirm({
      id: "payments",
      format: "atticus",
      summary: {
        items: 9,
        translatedPercent: 100,
        byAction: { adopt: 0, link: 8, ignore: 1 },
        byKind: { "atticus-orgpack": 2 },
      },
      problems: ["one thing"],
    });
    expect(meta.message).toContain("another Atticus metarepo");
    expect(meta.detail).toContain("1 problem: one thing");
  });

  it("says what accepting copies and keeps", () => {
    const a = acceptConfirm({
      id: "team-a",
      proposal: "proposals/absorb/team-a",
      copied: ["org-pack/process/skills/team-a-planner/SKILL.md"],
      same: [],
      kept: ["org-pack/process/commands/team-a-review.md"],
      linked: 4,
      entry: "added",
      sourcesFile: "org-pack/sources.yaml",
    });
    expect(a.message).toBe("Accept team-a into the metarepo? 1 file to copy; 4 items stay linked.");
    expect(a.detail).toContain("org-pack/process/skills/team-a-planner/SKILL.md");
    expect(a.detail).toContain("Kept as they are (someone changed them)");
    expect(a.detail).toContain("adds team-a under absorbed: in org-pack/sources.yaml");
  });
});

describe("plain words in the sections", () => {
  it("leads a question with the part that differs", () => {
    expect(
      questionLabel(
        "This came back after a draft had fixed it: The critic (constitution.story-acceptance-criteria): Story s4-leave has no acceptance criteria.",
      ),
    ).toEqual({
      label: "Story s4-leave has no acceptance criteria.",
      description: "came back · constitution.story-acceptance-criteria",
    });
    expect(questionLabel("Which file format should the export use?")).toEqual({
      label: "Which file format should the export use?",
    });
  });

  it("names a change by its title when it has one", () => {
    const titles = (id: string) => (id === "add-note-tags" ? "Let members tag notes" : undefined);
    expect(
      stepTitle({ step: "feature", command: "x", why: "y", change: "add-note-tags" }, titles),
    ).toBe("Place “Let members tag notes” on the flows and features");
    expect(stepTitle({ step: "feature", command: "x", why: "y", change: "other" }, titles)).toBe(
      "Place other on the flows and features",
    );
  });
});

describe("accepting with nothing to copy", () => {
  it("starts with what it adds, not a blank line", () => {
    const a = acceptConfirm({
      id: "pricing",
      proposal: "proposals/absorb/pricing",
      copied: [],
      same: [],
      kept: [],
      linked: 3,
      entry: "added",
      sourcesFile: "org-pack/sources.yaml",
    });
    expect(a.detail.startsWith("It adds pricing under absorbed:")).toBe(true);
  });
});

describe("Run a command, for a command with a guided screen", () => {
  it("opens the screen, which asks in plain words and shows what came of it", () => {
    expect(guidedCommand("knowledge find")).toBe("atticus.searchWikis");
    expect(guidedCommand("knowledge keep")).toBe("atticus.keepFound");
    expect(guidedCommand("sources add")).toBe("atticus.addWiki");
    expect(guidedCommand("orgpack draft")).toBe("atticus.draftOrgPack");
    expect(guidedCommand("orgpack accept")).toBe("atticus.draftOrgPack");
    expect(guidedCommand("repos discover")).toBe("atticus.addRepos");
    expect(guidedCommand("absorb")).toBe("atticus.absorb");
    expect(guidedCommand("absorb accept")).toBe("atticus.absorbAccept");
    expect(guidedCommand("questions answer")).toBe("atticus.answerQuestion");
    expect(guidedCommand("needs")).toBe("atticus.raiseNeeds");
    expect(guidedCommand("spec check")).toBeUndefined();
  });
});
