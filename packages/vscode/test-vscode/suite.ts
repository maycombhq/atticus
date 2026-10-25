import { writeFileSync } from "node:fs";
import * as vscode from "vscode";
import { pickList, requiredSwitches } from "../src/commands";
import { COPILOT_SETUP, copilotSetup } from "../src/describe";
import type { AtticusHandles } from "../src/extension";
import { FULL_WHEN } from "../src/surface";
import { WORDS } from "../src/words";

/**
 * The extension's checks inside a real VS Code (ADR 0098), run by scripts/test-in-vscode.mjs on a
 * practice metarepo: it activates, every command it declares is registered, the sections read
 * the metarepo, and the app opens in a tab from the extension's own files.
 */

const label = (t: vscode.TreeItem) =>
  typeof t.label === "string" ? t.label : (t.label?.label ?? "");

export async function run(): Promise<void> {
  const results: { check: string; ok: boolean; detail?: string }[] = [];
  // A check that never finishes fails, named, instead of holding the window open.
  const check = async (name: string, f: () => Promise<string | void>, ms = 60_000) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const detail = await Promise.race([
        f(),
        new Promise<never>((_, no) => {
          timer = setTimeout(() => no(new Error(`didn't finish in ${ms / 1000} s`)), ms);
        }),
      ]);
      results.push({ check: name, ok: true, ...(detail ? { detail } : {}) });
    } catch (e) {
      results.push({ check: name, ok: false, detail: (e as Error).message });
    } finally {
      clearTimeout(timer);
    }
    console.log(`[atticus test] ${results.at(-1)!.ok ? "ok" : "FAIL"} ${name}`);
  };
  const ext = vscode.extensions.getExtension<AtticusHandles>("maycombhq.atticus");
  if (!ext) throw new Error("The extension isn't loaded.");
  const h = await ext.activate();
  const late = setTimeout(
    () => console.log("[atticus test] still waiting for the extension to be ready"),
    30_000,
  );
  await h.ready;
  clearTimeout(late);

  await check("finds the metarepo and the command line", async () => {
    if (!h.service.root) throw new Error("no metarepo found in the workspace");
    if (!h.service.cliOk) throw new Error("atticus --version didn't run");
    return h.service.root;
  });

  await check("registers every command it declares", async () => {
    const all = new Set(await vscode.commands.getCommands(true));
    const declared = (ext.packageJSON.contributes.commands as { command: string }[]).map(
      (c) => c.command,
    );
    const missing = declared.filter((c) => !all.has(c));
    if (missing.length) throw new Error(`not registered: ${missing.join(", ")}`);
    return `${declared.length} commands`;
  });

  await check("Next says the next step in plain words", async () => {
    await h.view.refresh();
    const kids = h.view.getChildren();
    if (!kids.length) throw new Error("the Next section is empty");
    const first = label(h.view.getTreeItem(kids[0]!));
    if (/^Next: atticus /.test(first)) throw new Error(`still a command: ${first}`);
    return first;
  });

  // 0.3.1: a section answers at once with a Reading row, then its rows once read.
  await check("a section says it is reading, then shows what it read", async () => {
    const t = h.sections.catalog!;
    t.reset();
    const first = t.getChildren().map((n) => t.getTreeItem(n));
    if (!first.length || !/^Reading the catalog/.test(label(first[0]!)))
      throw new Error(`no Reading row: ${first.map(label).join(", ")}`);
    const read = await t.children();
    if (!read.length || /^Reading/.test(label(t.getTreeItem(read[0]!))))
      throw new Error("still reading");
    const now = t.getChildren().map((n) => label(t.getTreeItem(n)));
    if (now.some((l) => /^Reading/.test(l))) throw new Error(`shown: ${now.join(", ")}`);
    return `${label(first[0]!)} → ${now.length} rows`;
  });

  const top = async (name: string) => {
    const t = h.sections[name]!;
    return Promise.all((await t.children()).map((n) => t.getTreeItem(n)));
  };
  await check("Repos lists the manifest's repos", async () => {
    const items = (await top("repos")).map(label);
    if (!items.some((l) => l.startsWith("forge-")))
      throw new Error(`no Forge repo: ${items.join(", ")}`);
    return items.join(", ");
  });
  await check("Changes lists the practice change", async () => {
    const items = (await top("changes")).map(label);
    if (!items.length || items[0]!.startsWith("No changes"))
      throw new Error(items.join(", ") || "empty");
    return items.join(", ");
  });
  // Phase D: three views, in the order of a working day; the other four with atticus.fullUi.
  await check(
    "the sidebar reads Next and Waiting, Questions, Changes; Knowledge, Repos, Catalog, Model runs with atticus.fullUi",
    async () => {
      const views = (
        ext.packageJSON.contributes.views.atticus as { id: string; name: string; when?: string }[]
      ).map((v) => `${v.name} (${v.id})${v.when?.includes(FULL_WHEN) ? " full" : ""}`);
      const want = [
        "Next and Waiting (atticus.view)",
        "Questions (atticus.questions)",
        "Changes (atticus.changes)",
        "Knowledge (atticus.knowledge) full",
        "Repos (atticus.repos) full",
        "Catalog (atticus.catalog) full",
        "Model runs (atticus.runs) full",
      ];
      if (views.join(", ") !== want.join(", ")) throw new Error(views.join(", "));
      return views.map((v) => v.split(" (")[0]).join(", ");
    },
  );
  await check("Next and Waiting has what waits on you under the steps (Phase D)", async () => {
    await h.view.refresh();
    const rows = h.view.getChildren();
    const head = rows.find((n) => h.view.getTreeItem(n).id === "next:waiting");
    if (!head) throw new Error(rows.map((n) => label(h.view.getTreeItem(n))).join(", "));
    await h.waiting.children();
    const under = h.view.getChildren(head).map((n) => label(h.view.getTreeItem(n)));
    if (!under.length) throw new Error("nothing under Waiting on you");
    if (under.includes("Questions")) throw new Error(`the questions are here: ${under.join(", ")}`);
    return under.join(", ");
  });
  await check(
    "Questions lists the open questions by repo, or says none waits (Phase D)",
    async () => {
      await h.view.refresh();
      const q = h.questions;
      const rows = q.getChildren().map((n) => q.getTreeItem(n));
      if (!rows.length) throw new Error("empty");
      const first = label(rows[0]!);
      if (first === WORDS.noQuestions) return first;
      if (rows.some((r) => r.contextValue !== "atticus.questionRepo"))
        throw new Error(rows.map(label).join(", "));
      return rows.map((r) => `${label(r)} (${String(r.description)})`).join(", ");
    },
  );
  // ADR 0105 addendum: by change by default, each change with what is open on it.
  await check("Waiting on you is by change by default (ADR 0105)", async () => {
    const w = h.waiting;
    if (w.group !== "change") throw new Error(`grouped by ${w.group}`);
    w.reset();
    const rows = await w.children();
    const items = rows.map((n) => w.getTreeItem(n));
    const shown = items.map(label);
    if (shown.length === 1 && shown[0] === WORDS.nothingElseWaits) return shown[0];
    const odd = items.filter(
      (t) =>
        !/^waiting:(change:|other$|.*:error$)/.test(String(t.id)) ||
        (/^waiting:change:/.test(String(t.id)) && !/ · \d+ waiting/.test(String(t.description))),
    );
    if (odd.length) throw new Error(`not a change or the rest: ${odd.map(label).join(", ")}`);
    // What belongs to no change comes last.
    const other = items.findIndex((t) => t.id === "waiting:other");
    if (other >= 0 && other !== items.length - 1) throw new Error(`order: ${shown.join(", ")}`);
    return items.map((t) => `${label(t)} (${String(t.description)})`).join(", ");
  });
  await check("a filter narrows a section, and says when nothing matches (ADR 0105)", async () => {
    const t = h.sections.changes!;
    const all = (await t.children()).map((n) => t.getTreeItem(n));
    const first = all[0];
    if (!first || /^No changes/.test(label(first))) throw new Error("no change to filter");
    const id = String(first.id).replace(/^changes:change:/, "");
    try {
      t.setFilter(id.toUpperCase());
      const some = (await t.children()).map((n) => label(t.getTreeItem(n)));
      if (!some.includes(label(first)) || some.length > all.length)
        throw new Error(`filtered by ${id}: ${some.join(", ")}`);
      t.setFilter("forge-no-such-thing");
      const none = (await t.children()).map((n) => t.getTreeItem(n));
      if (none.length !== 1 || !/^Nothing in Changes matches/.test(label(none[0]!)))
        throw new Error(`nothing matched: ${none.map(label).join(", ")}`);
      if (none[0]!.command?.command !== "atticus.clearFilterChanges")
        throw new Error("the row doesn't clear the filter");
      await vscode.commands.executeCommand("atticus.clearFilterChanges");
      if (t.filter) throw new Error(`still filtered by ${t.filter}`);
      // Waiting on you's filter is its own.
      h.waiting.setFilter("forge-no-such-thing");
      const w = (await h.waiting.children()).map((n) => label(h.waiting.getTreeItem(n)));
      if (t.filter) throw new Error("the filters aren't each view's own");
      if (w.length !== 1 || !/^Nothing in Waiting on you matches/.test(w[0]!))
        throw new Error(`Waiting on you: ${w.join(", ")}`);
      return `${id}: ${some.length} of ${all.length} rows; then ${label(none[0]!)}`;
    } finally {
      t.setFilter("");
      await vscode.commands.executeCommand("atticus.clearFilterWaiting");
    }
  });
  await check(
    "Waiting on you says it is reading, then what waits, by kind (ADR 0105)",
    async () => {
      const w = h.waiting;
      await vscode.commands.executeCommand("atticus.waitingByKind");
      if (w.group !== "kind") throw new Error("Group by kind didn't");
      w.reset();
      const first = w.getChildren().map((n) => label(w.getTreeItem(n)));
      if (!/^Reading what waits on you/.test(first[0] ?? ""))
        throw new Error(`no Reading row: ${first.join(", ")}`);
      const rows = (await w.children()).map((n) => w.getTreeItem(n));
      await vscode.commands.executeCommand("atticus.waitingByChange");
      const groups = ["Questions", "Needs", "Manual steps", "Findings", "Knowledge to verify"];
      const shown = rows.map(label);
      if (shown.length === 1 && shown[0] === WORDS.nothingElseWaits) return shown[0];
      const odd = shown.filter((l) => !groups.includes(l));
      if (odd.length) throw new Error(`not a group: ${odd.join(", ")}`);
      // In order, and each with its count.
      const order = shown.map((l) => groups.indexOf(l));
      if (order.some((x, i) => i && x < order[i - 1]!))
        throw new Error(`order: ${shown.join(", ")}`);
      const uncounted = rows.filter((r) => !/^\d+ /.test(String(r.description ?? "")));
      if (uncounted.length) throw new Error(`no count: ${uncounted.map(label).join(", ")}`);
      return rows.map((r) => `${label(r)} (${String(r.description)})`).join(", ");
    },
  );
  await check("every step in Next runs when clicked", async () => {
    const rows = h.view.getChildren().map((n) => h.view.getTreeItem(n));
    const steps = rows.filter((r) => r.contextValue === "atticus.next");
    if (!steps.length) throw new Error("no step rows");
    const dead = steps.filter((r) => r.command?.command !== "atticus.runStep");
    if (dead.length) throw new Error(`no command: ${dead.map(label).join(", ")}`);
    return `${steps.length} step rows`;
  });
  await check("a change shows what it needs, or the step that finds it (ADR 0101)", async () => {
    const t = h.sections.changes!;
    const [change] = await t.children();
    if (!change) throw new Error("no change");
    const kids = (await t.children(change)).map((n) => t.getTreeItem(n));
    const needs = kids.find((k) => /^(Needs \(|Find what it needs)/.test(label(k)));
    if (!needs) throw new Error(`no needs row: ${kids.map(label).join(", ")}`);
    return label(needs);
  });
  await check("Knowledge offers its first step, or its sources and searches", async () => {
    const items = await top("knowledge");
    const labels = items.map(label);
    if (labels[0]?.startsWith("No knowledge yet")) {
      if (items[0]!.command?.command !== "atticus.addWiki")
        throw new Error("the empty row doesn't add a wiki");
      return labels[0];
    }
    if (
      !labels.some((l) => l.startsWith("Sources (")) ||
      !labels.some((l) => l.startsWith("Searches ("))
    )
      throw new Error(labels.join(", "));
    return labels.join(", ");
  });
  await check("Catalog lists what the scan read", async () => {
    const items = await top("catalog");
    if (!items.length) throw new Error("empty");
    return items.map((i) => `${label(i)} ${String(i.description ?? "")}`).join(", ");
  });

  await check("the status bar names the next step in plain words, as Next does", async () => {
    await h.view.refresh();
    for (let i = 0; i < 40 && !h.status.text.includes("next:"); i++)
      await new Promise((r) => setTimeout(r, 250));
    const t = h.status.text;
    if (!t.includes("next:")) throw new Error(`no next step: ${t}`);
    // A step's id alone (next: survey) is the command line's word, not a person's.
    if (/next: [a-z-]+$/.test(t)) throw new Error(`a step id: ${t}`);
    return t;
  });

  await check("Run a command offers every command the command line has", async () => {
    const cat = await h.commands.load(h.service.root!);
    const offered = pickList(cat, { developer: true }).filter((i) => !i.separator);
    if (offered.length !== cat.commands.length)
      throw new Error(`${offered.length} offered of ${cat.commands.length}`);
    // No approve flag is set before the dry run and the person's yes, and no switch asks a value.
    const bad = cat.commands.filter(
      (c) =>
        (c.approve && c.approve in requiredSwitches(c)) ||
        c.flags.some((f) => f.required && f.value && /^[A-Z][a-z]+$/.test(f.value)),
    );
    if (bad.length) throw new Error(`asked wrongly: ${bad.map((c) => c.id).join(", ")}`);
    return `${offered.length} commands`;
  });

  await check(
    "Model runs reads atticus runs, newest first, each opening to its files (ADR 0106)",
    async () => {
      const t = h.sections.runs!;
      const rows = (await t.children()).map((n) => t.getTreeItem(n));
      if (!rows.length) throw new Error("no rows");
      const first = rows[0]!;
      if (/^Couldn't read/.test(label(first))) throw new Error(label(first));
      if (/^No model runs yet/.test(label(first))) return label(first);
      const kids = (await t.children((await t.children())[0])).map((n) => label(t.getTreeItem(n)));
      if (kids[0] !== "Open the prompt" || kids.at(-1) !== "Open in the app")
        throw new Error(`a run opens to: ${kids.join(", ")}`);
      return `${rows.length} runs; the first opens to ${kids.join(", ")}`;
    },
  );

  await check(
    "Run with Copilot from the app refuses what isn't an AI step (ADR 0106)",
    async () => {
      const replies: Record<string, unknown>[] = [];
      const post = (r: object) => void replies.push(r as Record<string, unknown>);
      await h.runFromApp(
        { type: "run-step", id: 1, args: ["spec", "check", "forge-ledger"] },
        post,
      );
      await h.runFromApp(
        { type: "run-step", id: 2, args: ["scan", "survey", "forge-ledger", "--root", "/x"] },
        post,
      );
      const [a, b] = replies;
      if (replies.length !== 2 || a?.type !== "run-end" || a.state !== "refused" || a.id !== 1)
        throw new Error(`a local command: ${JSON.stringify(replies)}`);
      if (b?.state !== "refused" || !/starts with "-"/.test(String((b.lines as string[])[0])))
        throw new Error(`an option: ${JSON.stringify(b)}`);
      return String((a.lines as string[])[0]);
    },
  );

  await check("Set up Copilot uses VS Code's own setup when it has one", async () => {
    const all = await vscode.commands.getCommands(true);
    const s = copilotSetup(all);
    if (all.includes(COPILOT_SETUP) && s.command !== COPILOT_SETUP)
      throw new Error(`would run ${s.command}`);
    return s.command;
  });

  await check("opens the app in a tab, from the extension's own files", async () => {
    await vscode.commands.executeCommand("atticus.showApp", "#/architecture");
    for (let i = 0; i < 40 && !h.panel(); i++) await new Promise((r) => setTimeout(r, 250));
    const p = h.panel();
    if (!p) throw new Error("no Atticus tab");
    const html = p.webview.html;
    if (!/default-src 'none'/.test(html) || !/nonce-/.test(html))
      throw new Error("not the bundled app's page");
    if (/atticus-token/.test(html)) throw new Error("the page holds the session token");
    return "bundled page with its policy";
  });

  await check("opens the app on Home when no page is named (Phase D)", async () => {
    h.panel()?.dispose();
    await vscode.commands.executeCommand("atticus.showApp");
    for (let i = 0; i < 40 && !h.panel(); i++) await new Promise((r) => setTimeout(r, 250));
    const html = h.panel()?.webview.html ?? "";
    if (!html.includes('location.hash = "#/home"')) throw new Error("not on Home");
    return "#/home";
  });

  const out = process.env.ATTICUS_VSCODE_TEST_OUT;
  if (out) writeFileSync(out, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  if (failed.length) throw new Error(failed.map((f) => `${f.check}: ${f.detail}`).join("\n"));
}
