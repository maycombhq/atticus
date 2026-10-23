import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyTheme,
  inEditor,
  readChoice,
  resolveTheme,
  saveChoice,
  THEME_KEY,
  type ThemeChoice,
} from "../src/app/theme.js";
import { COPY } from "../src/copy.js";

// The browser app's theme: system (the default), light or dark, remembered per browser. Inside a
// VS Code panel the editor's own theme decides, as before (ADR 0098).

/** A browser's localStorage, or one that refuses (private windows, blocked site data). */
function storage(o: { value?: string; throws?: boolean } = {}) {
  const saved: Record<string, string> = o.value === undefined ? {} : { [THEME_KEY]: o.value };
  return {
    saved,
    getItem: (k: string) => {
      if (o.throws) throw new Error("SecurityError");
      return saved[k] ?? null;
    },
    setItem: (k: string, v: string) => {
      if (o.throws) throw new Error("QuotaExceededError");
      saved[k] = v;
    },
  };
}

/** Just enough of a document: the root element's data-theme and the body's classes. */
function page(bodyClasses: string[] = []) {
  const dataset: Record<string, string> = {};
  return {
    dataset,
    doc: {
      documentElement: { dataset, style: { colorScheme: "" } },
      body: { classList: { contains: (c: string) => bodyClasses.includes(c) } },
    },
  };
}

describe("the theme choice", () => {
  it("reads what the browser remembered, and anything else as system", () => {
    expect(readChoice(storage({ value: "light" }))).toBe("light");
    expect(readChoice(storage({ value: "dark" }))).toBe("dark");
    expect(readChoice(storage({ value: "system" }))).toBe("system");
    expect(readChoice(storage())).toBe("system");
    expect(readChoice(storage({ value: "solarized" }))).toBe("system");
  });

  it("falls back to system when there is no storage, and saving there doesn't throw", () => {
    expect(readChoice(storage({ throws: true }))).toBe("system");
    expect(readChoice(undefined)).toBe("system");
    expect(() => saveChoice("light", storage({ throws: true }))).not.toThrow();
    expect(() => saveChoice("light", undefined)).not.toThrow();
  });

  it("remembers a choice", () => {
    const s = storage();
    saveChoice("dark", s);
    expect(s.saved[THEME_KEY]).toBe("dark");
    expect(readChoice(s)).toBe("dark");
  });

  it("follows the system's light or dark preference only when the choice is system", () => {
    expect(resolveTheme("system", true)).toBe("light");
    expect(resolveTheme("system", false)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
  });

  it("puts the theme on the page's root element, where the light tokens apply", () => {
    const p = page();
    applyTheme("system", true, p.doc);
    expect(p.dataset.theme).toBe("light");
    expect(p.doc.documentElement.style.colorScheme).toBe("light");
    applyTheme("dark", true, p.doc);
    expect(p.dataset.theme).toBe("dark");
    expect(p.doc.documentElement.style.colorScheme).toBe("dark");
  });

  it("leaves a VS Code panel to the editor's theme", () => {
    for (const c of ["vscode-light", "vscode-dark", "vscode-high-contrast"]) {
      const p = page([c]);
      expect(inEditor(p.doc)).toBe(true);
      applyTheme("light", true, p.doc);
      expect(p.dataset.theme).toBeUndefined();
    }
    expect(inEditor(page().doc)).toBe(false);
  });

  it("names every choice from the copy file", () => {
    const choices: ThemeChoice[] = ["system", "light", "dark"];
    expect(choices.map((c) => COPY.theme.choices[c])).toEqual(["System", "Light", "Dark"]);
    expect(COPY.theme.label).toBe("Theme");
  });

  it("uses the one light palette: the browser's light theme shares VS Code light's block", () => {
    const css = readFileSync(
      fileURLToPath(new URL("../src/styles/hud.css", import.meta.url)),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    const light = [...css.matchAll(/([^{}]+)\{[^{}]*--ground:\s*#f4f6f8/g)].map((m) => m[1]!);
    expect(light).toHaveLength(1);
    expect(light[0]).toContain(':root[data-theme="light"]');
    expect(light[0]).toContain("body.vscode-light");
  });
});
