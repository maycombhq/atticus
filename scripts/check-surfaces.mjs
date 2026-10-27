// The surface census (ADR 0129). The product owner approved cutting Atticus 1 on condition that
// nothing breaks and the app loses no depth. The inventory in ADR 0129 is the promise; this is
// the guard. It counts and names every surface a person meets — the command line's commands, the
// app's pages, VS Code's views and palette commands, IntelliJ's tool-window tabs — and fails when
// one goes missing.
//
// It is not a style check. A surface may be retired: say so here, in the same commit, with the
// ADR that decided it and what does the job instead. Then the diff shows a page or a command
// leaving, which is the point. A number that drifts up needs no ADR; a name that disappears does.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { helpText, REPO } from "./help-text.mjs";

/**
 * Every surface, as of ADR 0129 (2026-10-26). `retired` names a surface this file used to list
 * and the ADR that retired it, so a reader can see what left and why.
 */
const CENSUS = {
  /** Distinct `atticus <group> [<sub>]` commands in the help text, which is the catalogue's source (ADR 0096). */
  commands: 225,
  /** The twelve a person meets first (ADR 0124 addendum D-cli). */
  topCommands: 12,
  /** Pages in the app (`packages/ui/src/app/screens.ts`). */
  screens: 52,
  /** Views in VS Code's Atticus container, and the commands its palette offers. */
  vscodeViews: 7,
  vscodePaletteCommands: 43,
  /** Tabs of IntelliJ's tool window (`Copy.kt`'s `*_TAB`). */
  intellijTabs: 9,
  retired: [],
};

/** The pages, by id, in the order screens.ts lists them. Every one must have a component. */
const SCREENS = [
  "home",
  "words",
  "canvas",
  "flows",
  "contracts",
  "impact",
  "trust",
  "explore",
  "systems",
  "map",
  "features",
  "mappings",
  "diagrams",
  "reconcile",
  "governance",
  "initiatives",
  "changes",
  "cockpit",
  "brief",
  "ux",
  "feature-design",
  "architecture",
  "arch-review",
  "change-diagram",
  "stories",
  "breakdown",
  "estimate",
  "task-list",
  "tasks",
  "conformance",
  "trace",
  "todo",
  "release",
  "service-desk",
  "questions",
  "knowledge",
  "wikis",
  "documents",
  "wiki-search",
  "parties",
  "orgpack-draft",
  "repos",
  "ai",
  "runs",
  "orgpack",
  "onboarding",
  "scans",
  "intake",
  "settings",
  "history",
  "evals",
  "learning",
];

const read = (p) => readFileSync(join(REPO, p), "utf8");
const problems = [];
const expect = (what, got, want) => {
  if (got !== want) problems.push(`${what}: ${got}, the census says ${want}`);
};

// ------------------------------------------------------------------ the command line
const lines = helpText()
  .split("\n")
  .filter((l) => /^\s{2}atticus\s/.test(l));
const ids = new Set(
  lines.map((l) => {
    const w = l.trim().split(/\s+/);
    const sub = /^[a-z][a-z-]*$/.test(w[2] ?? "") ? ` ${w[2]}` : "";
    return `${w[1]}${sub}`;
  }),
);
expect("commands in the help text", ids.size, CENSUS.commands);

const top = read("packages/cli/src/top-commands.ts");
const words = /export const TOP_WORDS = \[([\s\S]*?)\] as const;/.exec(top);
if (!words) problems.push("packages/cli/src/top-commands.ts: TOP_WORDS not found");
else expect("the top commands", [...words[1].matchAll(/"[a-z-]+"/g)].length, CENSUS.topCommands);

// A retired command keeps its words (ADR 0129 §4), so it must still be in the help text.
for (const r of CENSUS.retired)
  if (!ids.has(r.command))
    problems.push(
      `${r.command} was retired by ${r.adr} but is no longer in the help text; a retired command keeps its words (ADR 0129 §4)`,
    );

// ------------------------------------------------------------------ the app
const screensSrc = read("packages/ui/src/app/screens.ts");
const found = [...screensSrc.matchAll(/\{\s*id: "([a-z-]+)",\s*label:/g)].map((m) => m[1]);
expect("pages in screens.ts", found.length, CENSUS.screens);
const missing = SCREENS.filter((id) => !found.includes(id));
if (missing.length)
  problems.push(`pages the census names that screens.ts no longer has: ${missing.join(", ")}`);
const added = found.filter((id) => !SCREENS.includes(id));
if (added.length)
  problems.push(`pages screens.ts has that the census doesn't name: ${added.join(", ")}`);

// Every page has a component: the app falls back to "being built" for one that doesn't, which is
// how a page quietly stops working (ADR 0129 §2.3).
const registry = [
  "packages/ui/src/screens/registry.tsx",
  "packages/ui/src/screens/know/index.tsx",
  "packages/ui/src/screens/knowledge/index.tsx",
  "packages/ui/src/screens/run/index.ts",
]
  .map(read)
  .join("\n");
const unwired = found.filter(
  (id) => !new RegExp(`(^|[\\s{])"?${id}"?:`, "m").test(registry.replace(/\bid: /g, "")),
);
if (unwired.length)
  problems.push(`pages with no component, so the app shows "being built": ${unwired.join(", ")}`);

// ------------------------------------------------------------------ VS Code
const vscode = JSON.parse(read("packages/vscode/package.json"));
expect("VS Code views", vscode.contributes.views.atticus.length, CENSUS.vscodeViews);
expect(
  "VS Code palette commands",
  (vscode.contributes.menus?.commandPalette ?? []).length,
  CENSUS.vscodePaletteCommands,
);

// ------------------------------------------------------------------ IntelliJ
const copy = read("packages/intellij/src/main/kotlin/com/maycombhq/atticus/core/Copy.kt");
expect(
  "IntelliJ tool-window tabs",
  [...copy.matchAll(/^\s*const val \w*_TAB =/gm)].length,
  CENSUS.intellijTabs,
);

if (problems.length) {
  console.error("The surface census (ADR 0129) no longer matches the code:\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    "\nIf a surface was retired on purpose, record it in scripts/check-surfaces.mjs in the same",
  );
  console.error("commit, with the ADR that decided it and what does the job instead.");
  process.exit(1);
}
console.log(
  `Surface census passed: ${ids.size} commands (${CENSUS.topCommands} at the top), ${found.length} pages, ` +
    `${CENSUS.vscodeViews} VS Code views, ${CENSUS.vscodePaletteCommands} palette commands, ${CENSUS.intellijTabs} IntelliJ tabs.`,
);
