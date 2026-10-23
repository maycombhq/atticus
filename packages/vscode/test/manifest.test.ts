import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ADR 0096: what the extension offers in VS Code (package.json) and what its code registers agree,
 * so no menu item or palette entry does nothing and no command is unreachable.
 */

// Vitest runs in the package folder.
const HERE = join(process.cwd(), "test");
const pkg = JSON.parse(readFileSync(join(HERE, "../package.json"), "utf8")) as {
  contributes: {
    commands: { command: string }[];
    menus: Record<string, { command?: string; submenu?: string }[]>;
    submenus?: { id: string }[];
    views: Record<string, { id: string }[]>;
  };
};
const src = readdirSync(join(HERE, "../src"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => readFileSync(join(HERE, "../src", f), "utf8"))
  .join("\n");

describe("the extension's manifest and its code", () => {
  const declared = new Set(pkg.contributes.commands.map((c) => c.command));
  const registered = new Set(
    [
      ...src.matchAll(/reg\(\s*"(atticus\.[A-Za-z]+)"/g),
      ...src.matchAll(/\["(atticus\.[A-Za-z]+)", "/g),
    ].map((m) => m[1]!),
  );
  // The step commands are registered in a loop over STEP_COMMANDS.
  for (const s of ["survey", "verify", "spec", "feature", "architecture", "stories"])
    registered.add(`atticus.${s}`);

  it("registers every command it declares", () => {
    expect([...declared].filter((c) => !registered.has(c))).toEqual([]);
  });

  it("declares every command a menu offers, and every submenu it opens", () => {
    const entries = Object.values(pkg.contributes.menus).flat();
    const commands = entries.flatMap((x) => (x.command ? [x.command] : []));
    expect(commands.filter((c) => !declared.has(c))).toEqual([]);
    const submenus = new Set((pkg.contributes.submenus ?? []).map((s) => s.id));
    const opened = entries.flatMap((x) => (x.submenu ? [x.submenu] : []));
    expect(opened.filter((s) => !submenus.has(s))).toEqual([]);
    for (const s of submenus) expect(pkg.contributes.menus[s]?.length).toBeGreaterThan(0);
    expect(entries.every((x) => !!x.command !== !!x.submenu)).toBe(true);
  });

  it("links only to commands that exist, from the welcome views and the walkthrough (ADR 0098)", () => {
    const c = pkg.contributes as unknown as {
      viewsWelcome: { contents: string }[];
      walkthroughs: { steps: { description: string; media: { markdown: string } }[] }[];
    };
    const text = [
      ...c.viewsWelcome.map((v) => v.contents),
      ...c.walkthroughs.flatMap((w) => w.steps.map((s) => s.description)),
    ].join("\n");
    const linked = [...text.matchAll(/\(command:([A-Za-z.]+)/g)].map((m) => m[1]!);
    const builtIn = [
      "vscode.openFolder",
      "workbench.action.openSettings",
      "workbench.action.openWalkthrough",
    ];
    expect(linked.filter((x) => !declared.has(x) && !builtIn.includes(x))).toEqual([]);
    for (const w of c.walkthroughs)
      for (const s of w.steps)
        expect(readdirSync(join(HERE, "..", "media", "walkthrough"))).toContain(
          s.media.markdown.split("/").pop(),
        );
  });

  it("draws every view it declares", () => {
    const views = pkg.contributes.views.atticus!.map((v) => v.id);
    expect(
      views.filter((v) => !src.includes(`"${v}"`) && !src.includes(`\`atticus.\${name}\``)),
    ).toEqual([]);
  });

  it("offers each step once in the Command Palette: one of two commands that run it is hidden", () => {
    const hidden = new Set(
      (pkg.contributes.menus.commandPalette ?? [])
        .filter((m) => (m as { when?: string }).when === "false")
        .map((m) => m.command),
    );
    // atticus.draftSpec and atticus.spec both draft a repo's spec with Copilot.
    expect(hidden.has("atticus.draftSpec") && !hidden.has("atticus.spec")).toBe(true);
  });

  // ADR 0105: one arrangement, in the order of a working day.
  const title = (view: string) =>
    (pkg.contributes.menus["view/title"] as { command?: string; when?: string; group?: string }[])
      .filter((m) => m.when === `view == ${view}`)
      .map((m) => ({ command: m.command!, group: m.group ?? "" }));

  it("orders the sidebar Next, Waiting on you, Changes, Knowledge, Repos, Catalog (ADR 0105)", () => {
    const views = pkg.contributes.views.atticus! as { id: string; name: string }[];
    expect(views.map((v) => v.name)).toEqual([
      "Next",
      "Waiting on you",
      "Changes",
      "Knowledge",
      "Repos",
      "Catalog",
    ]);
    // The view keeps its id, so settings and keybindings that name it keep working.
    expect(views[1]!.id).toBe("atticus.questions");
  });

  it("keeps four buttons in Knowledge's title bar, the rest in three groups of its menu (ADR 0105)", () => {
    const k = title("atticus.knowledge");
    expect(k.filter((m) => m.group.startsWith("navigation")).map((m) => m.command)).toEqual([
      "atticus.addWiki",
      "atticus.searchWikis",
      "atticus.knowledgeScan",
      "atticus.sourcesSync",
    ]);
    const menu = k.filter((m) => !m.group.startsWith("navigation"));
    const groupOf = (c: string) => menu.find((m) => m.command === c)?.group.split("@")[0];
    expect(groupOf("atticus.knowledgeAsk")).toBeDefined();
    expect(groupOf("atticus.keepFound")).toBe(groupOf("atticus.knowledgeAsk"));
    const groups = [
      groupOf("atticus.knowledgeAsk"),
      groupOf("atticus.reviewUnverified"),
      groupOf("atticus.draftOrgPack"),
    ];
    expect(new Set(groups).size).toBe(3);
    // VS Code sorts a menu's groups by name: reading, then reviewing, then the org pack.
    expect([...groups].sort()).toEqual(groups);
    expect(menu.map((m) => m.command).sort()).toEqual(
      [
        "atticus.draftOrgPack",
        "atticus.keepFound",
        "atticus.knowledgeAsk",
        "atticus.reviewUnverified",
      ].sort(),
    );
  });

  it("brings in from another repo from the Repos menu, not Knowledge's (ADR 0105)", () => {
    expect(title("atticus.repos").find((m) => m.command === "atticus.absorb")?.group).toMatch(
      /^more/,
    );
    expect(title("atticus.knowledge").some((m) => m.command === "atticus.absorb")).toBe(false);
  });

  it("offers a need's and a finding's buttons in Waiting on you as in Changes (ADR 0105)", () => {
    const item = pkg.contributes.menus["view/item/context"] as {
      command?: string;
      when?: string;
    }[];
    const inWaiting = (c: string) =>
      item.some(
        (m) =>
          m.command === c &&
          /atticus\\?\.\(?[a-z|]*questions/.test(m.when ?? "") &&
          /changes/.test(m.when ?? ""),
      );
    for (const c of [
      "atticus.needDone",
      "atticus.needSkip",
      "atticus.openNeedPage",
      "atticus.findingAction",
    ])
      expect(inWaiting(c), c).toBe(true);
  });

  it("asks the catalog from the Catalog section's title bar", () => {
    expect(
      pkg.contributes.menus["view/title"]!.some(
        (m) =>
          m.command === "atticus.ask" &&
          (m as { when?: string }).when === "view == atticus.catalog",
      ),
    ).toBe(true);
  });
});
