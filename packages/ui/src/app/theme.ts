import { useEffect, useState } from "react";

/**
 * The browser app's theme: follow the system (the default), or always light, or always dark.
 * The choice is remembered per browser; with no storage (a private window, blocked site data)
 * it is system. The light theme is the same set of tokens VS Code light uses (hud.css), put on
 * the page's root as data-theme. Inside a VS Code panel the editor's theme decides, so the app
 * sets nothing there and shows no switch.
 */

export type ThemeChoice = "system" | "light" | "dark";
export const THEME_CHOICES: readonly ThemeChoice[] = ["system", "light", "dark"];
export const THEME_KEY = "atticus.theme";

type Store = Pick<Storage, "getItem" | "setItem">;
interface Doc {
  documentElement: { dataset: DOMStringMap; style: { colorScheme: string } };
  body: { classList: { contains(c: string): boolean } } | null;
}

/** The browser's localStorage, or undefined where even asking for it throws. */
function browserStore(): Store | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readChoice(store: Store | undefined = browserStore()): ThemeChoice {
  try {
    const v = store?.getItem(THEME_KEY);
    return THEME_CHOICES.includes(v as ThemeChoice) ? (v as ThemeChoice) : "system";
  } catch {
    return "system";
  }
}

export function saveChoice(c: ThemeChoice, store: Store | undefined = browserStore()): void {
  try {
    store?.setItem(THEME_KEY, c);
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
}

export function resolveTheme(c: ThemeChoice, prefersLight: boolean): "light" | "dark" {
  return c === "system" ? (prefersLight ? "light" : "dark") : c;
}

/** A VS Code webview: its <body> carries the editor's theme class. */
export function inEditor(doc: Doc = document): boolean {
  const b = doc.body?.classList;
  return !!b && ["vscode-light", "vscode-dark", "vscode-high-contrast"].some((c) => b.contains(c));
}

export function applyTheme(c: ThemeChoice, prefersLight: boolean, doc: Doc = document): void {
  if (inEditor(doc)) return;
  const t = resolveTheme(c, prefersLight);
  doc.documentElement.dataset.theme = t;
  // Native controls and scrollbars follow too.
  doc.documentElement.style.colorScheme = t;
}

const LIGHT = "(prefers-color-scheme: light)";
const prefersLight = (): boolean => !!globalThis.matchMedia?.(LIGHT).matches;

/** Put the remembered theme on the page before the first render. */
export function startTheme(): void {
  applyTheme(readChoice(), prefersLight());
}

/** The current choice and a setter that saves it; follows the system while it is system. */
export function useTheme(): [ThemeChoice, (c: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(() => readChoice());
  useEffect(() => {
    applyTheme(choice, prefersLight());
    if (choice !== "system") return;
    const mq = globalThis.matchMedia?.(LIGHT);
    if (!mq) return;
    const on = () => applyTheme("system", mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [choice]);
  return [
    choice,
    (c) => {
      saveChoice(c);
      setChoice(c);
    },
  ];
}
