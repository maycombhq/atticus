import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_HOME,
  COLLAPSED_VIEWS,
  DEFAULT_CHAT,
  DEFAULT_PALETTE,
  DEFAULT_VIEWS,
  FULL_WHEN,
  LEGACY_CHAT,
  LEGACY_PALETTE,
  TOP_COMMANDS,
} from "../src/surface";
import { SETTINGS_WORDS } from "../src/words";

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
  for (const s of [
    "survey",
    "scanverify",
    "spec",
    "feature",
    "architecture",
    "stories",
    "small",
    "map",
    "critic",
  ])
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

  it("says each model setting in the words words.ts keeps (ADR 0121 addendum)", () => {
    const conf = (pkg.contributes as unknown as { configuration: unknown }).configuration;
    const props = (Array.isArray(conf) ? conf[0] : conf) as {
      properties: Record<string, { markdownDescription?: string; type?: string }>;
    };
    for (const [key, words] of Object.entries(SETTINGS_WORDS)) {
      expect(props.properties[key]?.markdownDescription, key).toBe(words);
      expect(props.properties[key]?.type, key).toBe("string");
    }
    expect(Object.keys(props.properties).filter((k) => k.startsWith("atticus.models."))).toEqual(
      ["read", "draft", "critic", "knowledge", "quick"].map((c) => `atticus.models.${c}`),
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

  it("shows every view: the three a day starts from, then four collapsed (2026-10-25)", () => {
    const views = pkg.contributes.views.atticus! as {
      id: string;
      name: string;
      when?: string;
      visibility?: string;
    }[];
    // The product owner, 2026-10-25: "I see only 3 tabs". Every view is offered, none behind the
    // setting, in the order of a working day (ADR 0105).
    expect(views.map((v) => ({ id: v.id, name: v.name }))).toEqual(DEFAULT_VIEWS);
    for (const v of views) expect(v.when ?? "", v.id).not.toContain(FULL_WHEN);
    // The four below the three start collapsed, so the sidebar opens on Next and Waiting.
    expect(views.filter((v) => v.visibility === "collapsed").map((v) => v.id)).toEqual(
      COLLAPSED_VIEWS,
    );
    expect(views.slice(0, 3).every((v) => v.visibility === undefined)).toBe(true);
    // ADR 0106: the model runs at the bottom, collapsed.
    expect(views.at(-1)).toMatchObject({ id: "atticus.runs", visibility: "collapsed" });
    // The Next view hosts the welcome (no metarepo, no command line), so it has no condition.
    expect(views[0]!.when).toBeUndefined();
  });

  it("declares atticus.fullUi, off by default, for the legacy commands and the app's ui --full", () => {
    const c = pkg.contributes as unknown as {
      configuration: { properties: Record<string, { type: string; default: unknown }> };
    };
    expect(c.configuration.properties["atticus.fullUi"]).toMatchObject({
      type: "boolean",
      default: false,
    });
  });

  const palette = () =>
    Object.fromEntries(
      ((pkg.contributes.menus.commandPalette ?? []) as { command: string; when?: string }[]).map(
        (m) => [m.command, m.when],
      ),
    );

  it("offers every command in the Command Palette but Atticus 1's legacy ones", () => {
    const when = palette();
    const declared = pkg.contributes.commands.map((c) => c.command);
    // A command only its view's title bar or rows offer (focusedView, or never) isn't counted.
    const offered = declared.filter((c) => when[c] === undefined);
    // The everyday ones, in order, among them Open the prompt history.
    expect(offered.filter((c) => DEFAULT_PALETTE.includes(c))).toEqual(DEFAULT_PALETTE);
    for (const c of ["atticus.ask", "atticus.estimate", "atticus.runCommand", "atticus.addWiki"])
      expect(offered, c).toContain(c);
    // Behind the setting: only the legacy ones, each still in the palette with it on.
    const behind = declared.filter((c) => when[c] === FULL_WHEN);
    expect(behind).toEqual(LEGACY_PALETTE);
    const other = declared.filter(
      (c) =>
        when[c] !== undefined &&
        when[c] !== "false" &&
        when[c] !== FULL_WHEN &&
        !when[c]!.startsWith("focusedView"),
    );
    expect(other).toEqual([]);
  });

  it("offers the every-command runner (ADR 0096) wherever it is, and its key, without the setting", () => {
    const entries = Object.values(pkg.contributes.menus).flat() as {
      command?: string;
      when?: string;
    }[];
    // Only the legacy commands' palette entries name the setting.
    const named = entries.filter((x) => (x.when ?? "").includes(FULL_WHEN));
    expect(named.map((x) => x.command)).toEqual(LEGACY_PALETTE);
    const keys = (
      pkg.contributes as unknown as { keybindings: { command: string; when?: string }[] }
    ).keybindings;
    for (const k of keys) expect(k.when ?? "", k.command).not.toContain(FULL_WHEN);
    expect(keys.some((k) => k.command === "atticus.runCommand")).toBe(true);
  });

  it("offers every @atticus command but Atticus 1's legacy ones", () => {
    const chat = (
      pkg.contributes as unknown as {
        chatParticipants: { commands: { name: string; when?: string }[] }[];
      }
    ).chatParticipants[0]!.commands;
    expect(chat.filter((c) => !c.when).map((c) => c.name)).toEqual(DEFAULT_CHAT);
    const rest = chat.filter((c) => c.when);
    for (const c of rest) expect(c.when, c.name).toBe(FULL_WHEN);
    expect(rest.map((c) => c.name)).toEqual(LEGACY_CHAT);
    // The handler still answers each one: nothing is removed.
    for (const c of chat) expect(src, c.name).toMatch(new RegExp(`"${c.name}"`));
  });

  it("starts or brings in from the Next title bar, bringing in knowledge too, without the setting", () => {
    const start = pkg.contributes.menus["atticus.start"] as {
      command: string;
      group: string;
      when?: string;
    }[];
    expect(start.some((m) => m.group.startsWith("3_"))).toBe(true);
    for (const m of start) expect(m.when ?? "", m.command).not.toContain(FULL_WHEN);
  });

  it("opens the app on Home, one of its six entries (ADR 0124 addendum D-app)", () => {
    expect(APP_HOME).toBe("#/home");
    expect(src).not.toContain('"#/dashboard"');
  });

  it("keeps four buttons in Knowledge's title bar, the rest in three groups of its menu (ADR 0105)", () => {
    const k = title("atticus.knowledge");
    // The filter's buttons (the ADR's addendum) are the list's, beside them.
    const buttons = k.filter((m) => m.group.startsWith("navigation"));
    expect(buttons.map((m) => m.command).filter((c) => !/ilter[A-Z]/.test(c))).toEqual([
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

  it("offers a need's and a finding's buttons in Next and Waiting as in Changes (ADR 0105)", () => {
    const item = pkg.contributes.menus["view/item/context"] as {
      command?: string;
      when?: string;
    }[];
    const inWaiting = (c: string) =>
      item.some(
        (m) =>
          m.command === c &&
          /atticus\\?\.\(?[a-z|]*\bview\b/.test(m.when ?? "") &&
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

  // ADR 0105 addendum: grouped by change, and a filter where lists grow.
  const titleBar = (view: string) =>
    (pkg.contributes.menus["view/title"] as { command?: string; when?: string; group?: string }[])
      .filter((m) => (m.when ?? "").split(" && ")[0] === `view == ${view}`)
      .map((m) => ({ command: m.command!, when: m.when ?? "", group: m.group ?? "" }));

  it("switches what waits between By change and By kind from Next and Waiting's title bar (ADR 0105)", () => {
    const t = titleBar("atticus.view");
    const byKind = t.find((m) => m.command === "atticus.waitingByKind");
    const byChange = t.find((m) => m.command === "atticus.waitingByChange");
    // One button at a time: Group by kind while by change (the default), and back.
    expect(byKind?.when).toBe("view == atticus.view && atticus.waitingGroup != kind");
    expect(byChange?.when).toBe("view == atticus.view && atticus.waitingGroup == kind");
    for (const m of [byKind!, byChange!]) expect(m.group).toMatch(/^navigation/);
    const titles = Object.fromEntries(
      (pkg.contributes.commands as { command: string; title: string; icon?: string }[]).map((c) => [
        c.command,
        c,
      ]),
    );
    expect(titles["atticus.waitingByKind"]?.title).toBe("Group by kind");
    expect(titles["atticus.waitingByChange"]?.title).toBe("Group by change");
    expect(titles["atticus.waitingByKind"]?.icon).toBeDefined();
    expect(titles["atticus.waitingByChange"]?.icon).toBeDefined();
  });

  it("filters what waits, Changes and Knowledge from their title bars, with Clear filter (ADR 0105)", () => {
    const cmds = Object.fromEntries(
      (pkg.contributes.commands as { command: string; title: string; icon?: string }[]).map((c) => [
        c.command,
        c,
      ]),
    );
    for (const [view, name, key] of [
      ["atticus.view", "Waiting", "waiting"],
      ["atticus.changes", "Changes", "changes"],
      ["atticus.knowledge", "Knowledge", "knowledge"],
      ["atticus.runs", "Runs", "runs"],
    ] as const) {
      const t = titleBar(view);
      const filter = t.find((m) => m.command === `atticus.filter${name}`);
      const clear = t.find((m) => m.command === `atticus.clearFilter${name}`);
      expect(filter?.when, view).toBe(`view == ${view}`);
      expect(filter?.group, view).toMatch(/^navigation/);
      expect(clear?.when, view).toBe(`view == ${view} && atticus.filtered.${key}`);
      expect(clear?.group, view).toMatch(/^navigation/);
      expect(cmds[`atticus.filter${name}`]?.title).toBe("Filter…");
      expect(cmds[`atticus.clearFilter${name}`]?.title).toBe("Clear filter");
    }
    // Knowledge keeps its four buttons beside the filter's.
    const k = titleBar("atticus.knowledge").filter((m) => m.group.startsWith("navigation"));
    expect(k.map((m) => m.command).filter((c) => !/ilter[A-Z]|refresh/.test(c))).toEqual([
      "atticus.addWiki",
      "atticus.searchWikis",
      "atticus.knowledgeScan",
      "atticus.sourcesSync",
    ]);
  });

  it("refreshes the Model runs section from its title bar, and opens an answer only from a run (ADR 0106)", () => {
    expect(titleBar("atticus.runs").some((m) => m.command === "atticus.refresh")).toBe(false);
    const refresh = (pkg.contributes.menus["view/title"] as { command?: string; when?: string }[])
      .filter((m) => m.command === "atticus.refresh")
      .map((m) => m.when ?? "");
    expect(refresh.some((w) => /\|runs\)/.test(w))).toBe(true);
    const hidden = (pkg.contributes.menus.commandPalette ?? []) as {
      command?: string;
      when?: string;
    }[];
    expect(hidden.find((m) => m.command === "atticus.openRunAnswer")?.when).toBe("false");
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

describe("the twelve commands first (ADR 0124 addendum D-cli)", () => {
  it("knows the twelve in the order atticus help shows them", () => {
    // The command line's own list, read from its source (no build needed).
    const cli = readFileSync(join(HERE, "../../cli/src/top-commands.ts"), "utf8");
    const words = /export const TOP_WORDS = \[([^\]]*)\]/.exec(cli)![1]!;
    expect([...words.matchAll(/"([a-z-]+)"/g)].map((m) => m[1])).toEqual([...TOP_COMMANDS]);
  });

  it("walks a person through the twelve first, and puts scan and spec drafting under Legacy, last", () => {
    const steps = (
      pkg.contributes as unknown as {
        walkthroughs: { steps: { id: string; title: string; description: string }[] }[];
      }
    ).walkthroughs[0]!.steps;
    const legacy = steps.filter((s) => s.title.startsWith("Legacy: "));
    expect(legacy.length).toBeGreaterThan(0);
    // Every legacy step after every other step.
    expect(steps.slice(steps.length - legacy.length)).toEqual(legacy);
    const links = (s: { description: string }) =>
      [...s.description.matchAll(/\(command:([A-Za-z.]+)/g)].map((m) => m[1]!);
    for (const c of ["atticus.scanAll", "atticus.draftSpec"])
      expect(
        legacy.some((s) => links(s).includes(c)),
        c,
      ).toBe(true);
    const first = steps.slice(0, steps.length - legacy.length).flatMap(links);
    for (const c of ["atticus.map", "atticus.verify", "atticus.newChange", "atticus.stories"])
      expect(first, c).toContain(c);
    expect(first).not.toContain("atticus.scanAll");
    expect(first).not.toContain("atticus.draftSpec");
  });
});

describe("the extension's version (a release changes it, so VS Code can tell builds apart)", () => {
  const manifest = JSON.parse(readFileSync(join(HERE, "../package.json"), "utf8")) as {
    version: string;
  };
  const cli = JSON.parse(readFileSync(join(HERE, "../../cli/package.json"), "utf8")) as {
    version: string;
  };
  const changelog = readFileSync(join(HERE, "../CHANGELOG.md"), "utf8");

  it("has a CHANGELOG section that names the Atticus release it ships with", () => {
    const heading = changelog.split("\n").find((l) => l.startsWith(`## ${manifest.version} `));
    expect(heading, `CHANGELOG.md has no section for ${manifest.version}`).toBeDefined();
    expect(heading).toContain(`Atticus ${cli.version}`);
  });

  it("is a new version for each Atticus release: no two sections name the same one", () => {
    const named = [...changelog.matchAll(/^## \d+\.\d+\.\d+ .*with Atticus ([^)\s]+)\)/gm)];
    const releases = named.map((m) => m[1]);
    expect(releases.length).toBeGreaterThan(1);
    expect(new Set(releases).size).toBe(releases.length);
  });
});
