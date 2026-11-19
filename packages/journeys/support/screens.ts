/** Every screen by its route (the menu of ADR 0105, then More and the cross-change views), with the Forge change where a screen works on one. */
export const SCREENS = [
  // The Overview is part of Home (2026-10-24): #/dashboard opens Home, checked as "home" below.
  "onboarding",
  "feature-design?change=add-transfer-limit",
  // 2026-10-27: a change's knowledge, on its own page beside Feature design.
  "change-knowledge?change=add-transfer-limit",
  "stories?change=add-transfer-limit",
  "task-list?change=add-transfer-limit",
  "home",
  "questions",
  // The Surfaces design: the Map and its Read status tab (v30 slice 8: the Map keeps Map, Flows
  // and Read status; the Ecosystem map's address opens Systems, see MOVED below).
  "canvas",
  "trust",
  "explore",
  "flows",
  "impact?q=ledger-api",
  "impact?q=ledger-api&incident=1",
  "features",
  "orgpack",
  // ADR 0102: knowledge in the app.
  "wikis",
  "knowledge",
  "wiki-search?q=transfer",
  "parties",
  "orgpack-draft",
  // ADR 0122: the files in inputs/.
  "documents",
  // ADR 0121: how AI runs here.
  "ai",
  // ADR 0123: each repo's branches.
  "repos",
  // WP7.1: one change at a glance (a tab of Change: without a change it says to pick one in All
  // changes). WP7.7: a system's page.
  "cockpit",
  "cockpit?change=add-transfer-limit",
  "systems",
  // O4 (ADR 0149): the systems outside the estate.
  "outside",
  "intake",
  // v30 slice 8: Model runs, Prompt history, Scans and Catalog builds are Activity's tabs.
  "activity?tab=scans",
  "activity?tab=catalog-builds",
  "brief?change=add-transfer-limit",
  "ux?change=add-transfer-limit",
  "arch-review?change=add-transfer-limit",
  "diagrams",
  "change-diagram?change=add-transfer-limit",
  "estimate?change=add-transfer-limit",
  "conformance?change=add-transfer-limit",
  "architecture",
  // ADR 0124 addendum D-app, B10: the Architecture tab's findings for one change.
  "architecture?change=add-transfer-limit",
  "reconcile",
  "contracts",
  "mappings?change=add-transfer-limit",
  "breakdown?change=add-transfer-limit",
  "initiatives",
  "changes",
  "changes/add-transfer-limit",
  "changes?across=findings",
  "changes?across=tasks",
  "changes?across=stories",
  "changes?across=tests",
  "changes?across=requests",
  "changes?across=releases",
  // ADR 0105: needs across changes.
  "changes?across=needs",
  "tasks?change=add-transfer-limit",
  "trace?change=add-transfer-limit",
  "todo",
  "release",
  "release/add-transfer-limit",
  "service-desk",
  "governance",
  "evals",
  "learning",
  // ADR 0106: what Atticus asked a model and what it answered (Activity › Model runs).
  "activity",
  // ADR 0110: what people asked their assistant and what it answered (Activity › Prompt history).
  "activity?tab=history",
  // The Map's pages about one box, under More pages now (v30 slice 8).
  "decisions",
  // WP5.1: Atticus's own words.
  "words",
  "settings",
];

/**
 * v30 slice 8: the addresses of pages folded into another, and where each opens now. A bookmark
 * or an editor's link to one keeps working.
 */
export const MOVED: readonly (readonly [string, RegExp])[] = [
  ["runs", /#\/activity\?tab=runs$/],
  ["runs?run=run-1", /#\/activity\?tab=runs&run=run-1$/],
  ["history", /#\/activity\?tab=history$/],
  ["scans", /#\/activity\?tab=scans$/],
  ["catalog-builds", /#\/activity\?tab=catalog-builds$/],
  ["map", /#\/systems$/],
];
