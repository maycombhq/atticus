import { writeFileSync } from "node:fs";
import * as vscode from "vscode";
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
  const check = async (name: string, f: () => Promise<string | void>) => {
    try {
      const detail = await f();
      results.push({ check: name, ok: true, ...(detail ? { detail } : {}) });
    } catch (e) {
      results.push({ check: name, ok: false, detail: (e as Error).message });
    }
  };
  const ext = vscode.extensions.getExtension<AtticusHandles>("maycombhq.atticus");
  if (!ext) throw new Error("The extension isn't loaded.");
  const h = await ext.activate();
  await h.ready;

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

  const top = async (name: string) => {
    const t = h.sections[name]!;
    return Promise.all((await t.getChildren()).map((n) => t.getTreeItem(n)));
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
  await check("Catalog lists what the scan read", async () => {
    const items = await top("catalog");
    if (!items.length) throw new Error("empty");
    return items.map((i) => `${label(i)} ${String(i.description ?? "")}`).join(", ");
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
