import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ADR 0098: every colour is a token in hud.css, so a VS Code theme is only a different set of
// values. These checks keep it that way and keep the light set readable.

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const HUD = readFileSync(join(SRC, "styles", "hud.css"), "utf8");
const COLOUR = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/** The rule blocks of a stylesheet, comments removed: selector → body. */
function blocks(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(re)) {
    out.push({ selector: m[1]!.trim(), body: m[2]! });
  }
  return out;
}

function tokens(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

const isTheme = (selector: string) => selector === ":root" || selector.includes("vscode-");
const dark = tokens(blocks(HUD).find((b) => b.selector === ":root")!.body);
const light = tokens(
  blocks(HUD).find((b) => b.selector.includes("body.vscode-light") && !b.selector.includes(":not"))!
    .body,
);

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("the theme tokens", () => {
  it("leaves no colour literal outside the token blocks", () => {
    const found: string[] = [];
    for (const file of files(SRC)) {
      if (!/\.(css|tsx?)$/.test(file)) continue;
      const text = readFileSync(file, "utf8");
      const scan = file.endsWith(".css")
        ? blocks(text)
            .filter((b) => !(file.endsWith("hud.css") && isTheme(b.selector)))
            .map((b) => `${b.selector} { ${b.body} }`)
        : text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
      for (const line of scan) if (COLOUR.test(line)) found.push(`${file}: ${line.trim()}`);
    }
    expect(found).toEqual([]);
  });

  it("gives the light set a value for every colour token", () => {
    const fonts = new Set(["--font", "--display", "--mono"]);
    const missing = [...dark.keys()].filter((k) => !fonts.has(k) && !light.has(k));
    expect(missing).toEqual([]);
  });

  it("keeps light text at 4.5:1 and marks at 3:1 on every light ground", () => {
    const grounds = ["--ground", "--panel", "--box", "--nav", "--input", "--hero"];
    const text = [
      "--text",
      "--text-2",
      "--muted",
      "--muted-2",
      "--faint",
      "--gone",
      "--nav-text",
      "--btn-text",
      "--placeholder",
      "--accent",
      "--accent-soft",
      "--accent-pale",
      "--magenta-text",
      "--danger-text",
      "--amber",
      "--amber-text",
      "--green",
      "--violet",
      "--violet-text",
      "--flow-label",
      "--attribution-text",
    ];
    const marks = ["--magenta", "--line-2", "--line-input", "--step-off", "--flow-table"];
    const low: string[] = [];
    for (const g of grounds) {
      for (const [list, min] of [
        [text, 4.5],
        [marks, 3],
      ] as const) {
        for (const t of list) {
          const ratio = contrast(light.get(t)!, light.get(g)!);
          if (ratio < min) low.push(`${t} on ${g}: ${ratio.toFixed(2)}`);
        }
      }
    }
    expect(contrast(light.get("--on-accent")!, light.get("--accent")!)).toBeGreaterThanOrEqual(4.5);
    expect(low).toEqual([]);
  });
});
