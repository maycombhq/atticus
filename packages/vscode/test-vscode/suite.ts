import { writeFileSync } from "node:fs";
import * as vscode from "vscode";
import { pickList, requiredSwitches } from "../src/commands";
import { COPILOT_SETUP, copilotSetup } from "../src/describe";
import type { AtticusHandles } from "../src/extension";

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

  const out = process.env.ATTICUS_VSCODE_TEST_OUT;
  if (out) writeFileSync(out, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  if (failed.length) throw new Error(failed.map((f) => `${f.check}: ${f.detail}`).join("\n"));
}
