import * as vscode from "vscode";
import { chatHandler } from "../src/chat";
import type { AtticusHandles } from "../src/extension";
import { DEFAULT_PALETTE } from "../src/surface";
import { WORDS } from "../src/words";
import { choose, Person, type Shown, until } from "./drive";
import type { Check } from "./suite";

/**
 * What a person does, in a real VS Code (ADR 0098; Phase D's surface): every command the
 * Command Palette offers, run as from the palette, its lists picked and its dialogs answered by
 * `Person`; Verify a repo's facts through VS Code's own pick list and terminal; @atticus's steps
 * with the editor's model, here without one (no Copilot in the test VS Code); and the window with
 * no folder open.
 */

const REPO = "forge-ledger";
const CHANGE = "Add a daily transfer limit";
const said = (p: Person) =>
  p.shown.map((s) => `${s.kind}${s.modal ? " (dialog)" : ""}: ${s.message}`).join(" | ");
const settle = () => new Promise((r) => setTimeout(r, 1500));
/** No copilot here: an AI step stops on the dialog that says to set Copilot up. */
const noModel = (s: Shown) => s.modal && s.kind === "warning" && /Copilot/.test(s.detail ?? "");

interface Step {
  /** In the list the command opens (createQuickPick), the row to pick. */
  pick?: string;
  /** What to type in its input box. */
  input?: string;
  /** What it must show, said as an error when it didn't. */
  expect: (p: Person, h: AtticusHandles) => string | undefined;
}

const PALETTE: Record<string, Step> = {
  "atticus.next": {
    expect: (p) =>
      p.shown.some((s) => s.modal && s.message.startsWith("Next: "))
        ? undefined
        : "no Next: dialog",
  },
  "atticus.runNext": { expect: (p) => (p.shown.some(noModel) ? undefined : "no Copilot dialog") },
  "atticus.map": {
    pick: REPO,
    expect: (p) => (p.shown.some(noModel) ? undefined : "no Copilot dialog"),
  },
  "atticus.feature": {
    pick: CHANGE,
    expect: (p) => (p.shown.length ? undefined : "nothing said"),
  },
  "atticus.architecture": {
    pick: CHANGE,
    expect: (p) => (p.shown.length ? undefined : "nothing said"),
  },
  "atticus.stories": {
    pick: CHANGE,
    expect: (p) => (p.shown.length ? undefined : "nothing said"),
  },
  "atticus.critic": {
    pick: CHANGE,
    expect: (p) => (p.shown.length ? undefined : "nothing said"),
  },
  "atticus.answer": {
    expect: (p) =>
      p.shown.some((s) => s.message === "No question is waiting for an answer.")
        ? undefined
        : "didn't say no question waits",
  },
  "atticus.showApp": { expect: (_p, h) => (h.panel() ? undefined : "no Atticus tab") },
  "atticus.showLog": { expect: () => undefined },
  "atticus.newChange": {
    expect: (p) => (p.inputs.includes("Atticus: New change") ? undefined : "no title asked"),
  },
  "atticus.startTask": {
    pick: CHANGE,
    expect: (p) => (p.shown.length || p.picks.length ? undefined : "nothing said"),
  },
  "atticus.checkHealth": { expect: (p) => (p.shown.length ? undefined : "nothing said") },
  "atticus.pickModel": {
    expect: (p) => (p.picks.some((x) => x.title === WORDS.pickModel) ? undefined : "no model list"),
  },
};

async function runAsFromPalette(p: Person, h: AtticusHandles, id: string, step: Step) {
  p.reset();
  if (step.input) p.input = () => step.input;
  let done = false;
  let failed: unknown;
  void Promise.resolve(vscode.commands.executeCommand(id)).then(
    () => (done = true),
    (e: unknown) => {
      failed = e;
      done = true;
    },
  );
  if (step.pick) await choose(p, step.pick);
  await until(() => done, 60_000, `${id} to finish`);
  if (failed) throw failed instanceof Error ? failed : new Error(String(failed));
  // What a command does after it returns (a step's end, a notice) comes a moment later.
  await settle();
  for (let i = 0; i < 40 && step.expect(p, h); i++) await new Promise((r) => setTimeout(r, 250));
  const wrong = step.expect(p, h);
  if (wrong) throw new Error(`${wrong}; it said ${said(p) || "nothing"}`);
  const errors = p.errors();
  if (errors.length) throw new Error(`an error: ${errors.map((e) => e.message).join(" | ")}`);
  await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
  return said(p) || "(nothing to say)";
}

export async function asAPerson(check: Check, h: AtticusHandles) {
  const p = new Person();
  p.install();
  try {
    await check("the checks answer what the extension asks, as a person would", async () => {
      if (!(await p.works())) throw new Error("the extension's dialogs don't come to the checks");
      p.reset();
    });

    // Every command the palette offers has its check (Verify's is the one after these).
    for (const id of DEFAULT_PALETTE.filter((c) => c !== "atticus.verify"))
      await check(
        `${id} runs from the palette without an error`,
        () => {
          const step = PALETTE[id];
          if (!step) throw new Error(`no check says what ${id} should do`);
          return runAsFromPalette(p, h, id, step);
        },
        90_000,
      );

    // ADR 0124: the repo picked in Atticus's list, how in VS Code's own, the check in a terminal.
    await check(
      "Verify a repo's facts: pick the repo, then how, and the check runs in a terminal",
      async () => {
        p.reset();
        p.pick = "real";
        const terminals = p.terminals.length;
        const run = Promise.resolve(vscode.commands.executeCommand("atticus.verify"));
        await choose(p, REPO);
        await until(() => p.picks.length > 0, 20_000, "the how list");
        const how = p.picks[0]!;
        if (how.items.join(" / ") !== "Check the facts / Check them and put them in the catalog")
          throw new Error(`offered ${how.items.join(" / ")}`);
        await new Promise((r) => setTimeout(r, 500));
        await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
        await run;
        await until(() => p.terminals.length > terminals, 20_000, "a terminal");
        const t = p.terminals.at(-1)!;
        await until(() => t.exitStatus !== undefined, 60_000, "atticus verify to end");
        if (t.exitStatus!.code !== 0) throw new Error(`atticus verify ended ${t.exitStatus!.code}`);
        if (p.errors().length) throw new Error(said(p));
        t.dispose();
        return `${how.title}: ${how.items[0]}; terminal "${t.name}" ended 0`;
      },
      90_000,
    );

    await chat(check, h);
  } finally {
    p.uninstall();
  }
}

/** A chat stream that keeps what @atticus wrote. */
function stream() {
  const out: string[] = [];
  const s = {
    markdown: (m: string | vscode.MarkdownString) =>
      void out.push(typeof m === "string" ? m : m.value),
    progress: (m: string) => void out.push(`(progress) ${m}`),
    button: (c: vscode.Command) => void out.push(`[${c.title}]`),
    anchor: () => undefined,
    reference: () => undefined,
    filetree: () => undefined,
    push: () => undefined,
  };
  return { s: s as unknown as vscode.ChatResponseStream, text: () => out.join("\n") };
}

async function ask(h: AtticusHandles, command: string | undefined, prompt: string) {
  const { s, text } = stream();
  const request = {
    command,
    prompt,
    references: [],
    toolReferences: [],
    model: undefined,
  } as unknown as vscode.ChatRequest;
  const handler = chatHandler(h.service, () => h.commands);
  await handler(
    request,
    { history: [] } as unknown as vscode.ChatContext,
    s,
    new vscode.CancellationTokenSource().token,
  );
  return text();
}

/**
 * @atticus: the participant VS Code registered (the manifest's), and its handler run here as
 * VS Code would run it, with no model: Copilot isn't in the test VS Code.
 */
async function chat(check: Check, h: AtticusHandles) {
  await check("@atticus /next says the next step with a button to run it", async () => {
    const t = await ask(h, "next", "");
    if (!/\*\*Next: /.test(t) || !/\[Run /.test(t)) throw new Error(t);
    return t.split("\n").find((l) => l.startsWith("**Next"));
  });
  await check("@atticus /answer says no question waits", async () => {
    const t = await ask(h, "answer", "");
    if (!t.includes("No question is waiting for an answer.")) throw new Error(t);
  });
  await check("@atticus /verify forge-ledger checks the facts, no model needed", async () => {
    const t = await ask(h, "verify", REPO);
    if (!/2 facts kept, 0 rejected/.test(t) || !t.includes("[Put the facts in the catalog]"))
      throw new Error(t);
    return "2 facts kept, 0 rejected";
  });
  await check("@atticus /map without a model says to set Copilot up", async () => {
    const t = await ask(h, "map", REPO);
    if (!/Copilot|model/i.test(t)) throw new Error(t);
    return t
      .split("\n")
      .filter((l) => l.startsWith("**"))
      .join(" ");
  });
}

/** The window with no folder: the extension starts, says what is missing, and runs nothing. */
export async function noFolder(
  check: Check,
  h: AtticusHandles,
  ext: vscode.Extension<AtticusHandles>,
) {
  await check("with no folder it finds no metarepo, and still finds the command line", async () => {
    if (h.service.root) throw new Error(`found ${h.service.root}`);
    if (!h.service.cliOk) throw new Error("atticus --version didn't run");
  });
  await check("with no folder every command it declares is registered", async () => {
    const all = new Set(await vscode.commands.getCommands(true));
    const declared = (ext.packageJSON.contributes.commands as { command: string }[]).map(
      (c) => c.command,
    );
    const missing = declared.filter((c) => !all.has(c));
    if (missing.length) throw new Error(`not registered: ${missing.join(", ")}`);
  });
  await check("with no folder the status bar says nothing", async () => {
    if (h.status.text) throw new Error(h.status.text);
  });
  const p = new Person();
  p.install();
  try {
    for (const id of DEFAULT_PALETTE)
      await check(`with no folder ${id} says to open or create a metarepo`, async () => {
        p.reset();
        await vscode.commands.executeCommand(id);
        await until(() => p.shown.length > 0, 10_000, "a notice").catch(() => undefined);
        if (id === "atticus.showLog" || id === "atticus.pickModel") return said(p) || "(none)";
        if (id === "atticus.checkHealth") {
          if (!p.shown.some((s) => /ready\. Open or create a metarepo/.test(s.message)))
            throw new Error(said(p));
          return said(p);
        }
        if (!p.shown.some((s) => /needs an Atticus metarepo/.test(s.message)))
          throw new Error(said(p) || "nothing said");
        if (p.errors().length) throw new Error(said(p));
        return p.shown[0]!.actions.join(", ");
      });
    await check("with no folder @atticus says to open the metarepo", async () => {
      const t = await ask(h, "next", "");
      if (!/Open the metarepo folder/.test(t)) throw new Error(t);
    });
  } finally {
    p.uninstall();
  }
}
