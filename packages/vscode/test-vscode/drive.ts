import { execFileSync } from "node:child_process";
import { join } from "node:path";
import * as vscode from "vscode";

/**
 * A person at the keyboard, for the checks in a real VS Code: what the extension shows is
 * recorded, and answered as the check says. Notifications and dialogs (a modal one would hold the
 * window) and input boxes are answered here; the extension's own pick lists (createQuickPick)
 * and terminals are VS Code's real ones, recorded so a check can pick in them. It works where the
 * suite shares the extension's `vscode` (the extension development host runs the suite from the
 * extension's folder); `works()` says whether it does.
 */

export interface Shown {
  kind: "info" | "warning" | "error";
  message: string;
  detail?: string;
  modal: boolean;
  actions: string[];
}

type Answer = (s: Shown) => string | undefined;
type PickAnswer = (
  items: readonly vscode.QuickPickItem[],
  options: vscode.QuickPickOptions | undefined,
) => vscode.QuickPickItem | undefined;

export class Person {
  shown: Shown[] = [];
  inputs: string[] = [];
  picks: { title: string; items: string[] }[] = [];
  lists: vscode.QuickPick<vscode.QuickPickItem>[] = [];
  terminals: vscode.Terminal[] = [];
  /** How dialogs and notifications are answered: dismissed, unless a check says otherwise. */
  answer: Answer = () => undefined;
  /** What an input box is answered with: Escape, unless a check says otherwise. */
  input: (title: string) => string | undefined = () => undefined;
  /** showQuickPick: VS Code's real list (picked with `accept`), or answered here. */
  pick: PickAnswer | "real" = () => undefined;
  private restore: (() => void)[] = [];

  install() {
    const w = vscode.window as unknown as Record<string, unknown>;
    const swap = (name: string, f: unknown) => {
      const was = w[name];
      w[name] = f;
      this.restore.push(() => (w[name] = was));
    };
    const message =
      (kind: Shown["kind"]) =>
      (msg: string, ...rest: unknown[]): Thenable<unknown> => {
        const opts =
          rest[0] && typeof rest[0] === "object" && !("title" in (rest[0] as object))
            ? (rest.shift() as vscode.MessageOptions)
            : undefined;
        const items = rest as (string | vscode.MessageItem)[];
        const s: Shown = {
          kind,
          message: msg,
          modal: !!opts?.modal,
          actions: items.map((i) => (typeof i === "string" ? i : i.title)),
          ...(opts?.detail ? { detail: opts.detail } : {}),
        };
        this.shown.push(s);
        const a = this.answer(s);
        return Promise.resolve(
          a === undefined
            ? undefined
            : items.find((i) => (typeof i === "string" ? i : i.title) === a),
        );
      };
    swap("showInformationMessage", message("info"));
    swap("showWarningMessage", message("warning"));
    swap("showErrorMessage", message("error"));
    swap("showInputBox", (o?: vscode.InputBoxOptions) => {
      const t = o?.title ?? o?.prompt ?? "";
      this.inputs.push(t);
      return Promise.resolve(this.input(t));
    });
    const realPick = vscode.window.showQuickPick.bind(vscode.window);
    swap(
      "showQuickPick",
      async (
        items: readonly vscode.QuickPickItem[] | Thenable<readonly vscode.QuickPickItem[]>,
        options?: vscode.QuickPickOptions,
        token?: vscode.CancellationToken,
      ) => {
        const list = await items;
        this.picks.push({
          title: options?.title ?? options?.placeHolder ?? "",
          items: list.map((i) => i.label),
        });
        if (this.pick === "real") return realPick(list, options, token);
        return this.pick(list, options);
      },
    );
    const realList = vscode.window.createQuickPick.bind(vscode.window);
    swap("createQuickPick", () => {
      const qp = realList();
      this.lists.push(qp as vscode.QuickPick<vscode.QuickPickItem>);
      return qp;
    });
    const realTerminal = vscode.window.createTerminal.bind(vscode.window) as (
      ...a: unknown[]
    ) => vscode.Terminal;
    swap("createTerminal", (...a: unknown[]) => {
      const t = realTerminal(...a);
      this.terminals.push(t);
      return t;
    });
  }

  uninstall() {
    for (const r of this.restore.reverse()) r();
    this.restore = [];
  }

  /** Whether the extension's calls come here: one it makes with no metarepo needed. */
  async works(): Promise<boolean> {
    const before = this.inputs.length;
    await vscode.commands.executeCommand("atticus.filterRuns");
    return this.inputs.length > before;
  }

  /** Forget what was shown, and answer the defaults again. */
  reset() {
    this.shown = [];
    this.inputs = [];
    this.picks = [];
    this.lists = [];
    this.answer = () => undefined;
    this.input = () => undefined;
    this.pick = () => undefined;
  }

  errors() {
    return this.shown.filter((s) => s.kind === "error");
  }
}

/**
 * A picture of the screen into ATTICUS_VSCODE_TEST_SHOTS, for a person to look at what the checks
 * saw (ImageMagick's import, on X; nothing elsewhere or when it isn't installed). Never a check.
 */
export function shot(name: string) {
  const dir = process.env.ATTICUS_VSCODE_TEST_SHOTS;
  if (!dir || process.platform !== "linux" || !process.env.DISPLAY) return;
  try {
    execFileSync("import", ["-window", "root", join(dir, `${name}.png`)], { timeout: 20_000 });
  } catch {
    // No picture: the checks don't depend on it.
  }
}

export const until = async (f: () => boolean | Promise<boolean>, ms = 30_000, what = "it") => {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error(`waited ${ms / 1000} s for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

/** In the extension's open pick list, once read: pick the row labelled `label`, as Enter does. */
export async function choose(p: Person, label: string, from = 0) {
  let qp: vscode.QuickPick<vscode.QuickPickItem> | undefined;
  await until(
    () => {
      qp = p.lists.slice(from).find((q) => !q.busy && q.items.length > 0);
      return !!qp;
    },
    30_000,
    `a pick list with ${label}`,
  );
  const item = qp!.items.find((i) => i.label === label);
  if (!item) throw new Error(`no ${label} in ${qp!.items.map((i) => i.label).join(", ")}`);
  qp!.activeItems = [item];
  await new Promise((r) => setTimeout(r, 300));
  await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
}
