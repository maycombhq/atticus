import * as vscode from "vscode";

/**
 * A pick list that shows at once (0.3.1). Its items are read while it is open, with VS Code's busy
 * bar and "Reading…" in the box, so a click never seems to do nothing. A read that fails says why
 * and offers the Atticus output; a read that finds nothing says so, or does what `empty` says.
 */

export interface LoadingPick<T extends vscode.QuickPickItem> {
  title: string;
  /** In the box while it reads, e.g. "Reading the open questions…". */
  reading: string;
  /** In the box once read. */
  placeholder?: string;
  /** What to say, or do, when there is nothing to pick. */
  empty: string | (() => unknown);
  many?: boolean;
  matchOnDescription?: boolean;
  matchOnDetail?: boolean;
  /** The output to offer when the read fails. */
  log?: vscode.OutputChannel;
  /** The item to have selected to start with (one pick). */
  active?: (item: T) => boolean;
}

/** One pick, or undefined when the person closed it, it failed or there was nothing. */
export async function pickLoading<T extends vscode.QuickPickItem>(
  o: LoadingPick<T>,
  read: () => Promise<T[]> | T[],
): Promise<T | undefined> {
  const r = await open({ ...o, many: false }, read);
  return r?.[0];
}

/** Several picks; undefined when the person closed it, it failed or there was nothing. */
export function pickManyLoading<T extends vscode.QuickPickItem>(
  o: LoadingPick<T>,
  read: () => Promise<T[]> | T[],
): Promise<T[] | undefined> {
  return open({ ...o, many: true }, read);
}

async function open<T extends vscode.QuickPickItem>(
  o: LoadingPick<T>,
  read: () => Promise<T[]> | T[],
): Promise<T[] | undefined> {
  const qp = vscode.window.createQuickPick<T>();
  qp.title = o.title;
  qp.placeholder = o.reading;
  qp.busy = true;
  qp.ignoreFocusOut = true;
  qp.canSelectMany = !!o.many;
  qp.matchOnDescription = o.matchOnDescription ?? true;
  qp.matchOnDetail = o.matchOnDetail ?? false;
  let closed = false;
  let settle: (v: T[] | undefined) => void = () => undefined;
  const result = new Promise<T[] | undefined>((done) => (settle = done));
  qp.onDidHide(() => {
    closed = true;
    settle(undefined);
    qp.dispose();
  });
  qp.onDidAccept(() => {
    if (qp.busy) return;
    const picked = o.many ? [...qp.selectedItems] : qp.selectedItems.slice(0, 1);
    if (!o.many && !picked.length) return;
    settle(picked);
    qp.hide();
  });
  qp.show();
  let items: T[];
  try {
    items = await read();
  } catch (e) {
    if (!closed) qp.hide();
    const pick = await vscode.window.showErrorMessage(
      `${o.title}: couldn't read the list. ${(e as Error).message}`,
      ...(o.log ? ["Show the output"] : []),
    );
    if (pick) o.log?.show(true);
    return undefined;
  }
  if (closed) return undefined;
  const real = items.filter((i) => i.kind !== vscode.QuickPickItemKind.Separator);
  if (!real.length) {
    qp.hide();
    if (typeof o.empty === "string") void vscode.window.showInformationMessage(o.empty);
    else await o.empty();
    return undefined;
  }
  qp.items = items;
  if (o.many) qp.selectedItems = real.filter((i) => i.picked);
  else {
    const first = real.find((i) => o.active?.(i));
    if (first) qp.activeItems = [first];
  }
  qp.placeholder = o.placeholder ?? "";
  qp.busy = false;
  return result;
}
