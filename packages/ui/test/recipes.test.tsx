import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import { RecipesView } from "../src/screens/map/Decisions.js";
import { AiSettingsForm, type AiSettings } from "../src/screens/run/AiSettings.js";

/**
 * ADR 0210 parts 2 and 6 in the app: Map › Decided by AI lists each type's recipes, proven (read
 * with no model) or a draft and why; Set up › AI says whether the deterministic readers run.
 */
const R = COPY.decisions.recipes;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

describe("recipes in the app (ADR 0210 part 2)", () => {
  it("shows a recipe, what it reads and whether it is proven", () => {
    const h = renderToStaticMarkup(
      <RecipesView
        v={{
          readers: "off",
          recipes: [
            {
              type: "integration-module",
              key: "blueprint-rest-entries",
              file: "org-pack/reading-rules/types/integration-module.yaml",
              fact: "entry",
              files: ["src/main/resources/OSGI-INF/blueprint/*.xml"],
              proven: true,
              repos: ["forge-wallets-module", "forge-ledger-module"],
            },
            {
              type: "integration-module",
              key: "deploy-settings",
              file: "org-pack/reading-rules/types/integration-module.yaml",
              fact: "config",
              files: ["deploy/*.yaml"],
              proven: false,
              repos: [],
              why: "has changed since its proof",
            },
          ],
        }}
      />,
    );
    expect(h).toContain(esc(R.proven(["forge-wallets-module", "forge-ledger-module"])));
    expect(h).toContain(esc(R.draft("has changed since its proof")));
    expect(h).toContain(esc(R.readers("off")));
  });

  it("says when there is none", () => {
    const h = renderToStaticMarkup(<RecipesView v={{ readers: "on", recipes: [] }} />);
    expect(h).toContain(esc(R.none));
    expect(h).toContain(esc(R.readers("on")));
  });
});

describe("the readers on Set up › AI (ADR 0210 part 6)", () => {
  it("says they are off, and how to turn them on", () => {
    const data: AiSettings = {
      ai: "on",
      modes: { allowed: ["hand-off"], default: "hand-off" },
      assistants: [],
      providers: [],
      model: null,
      keySet: false,
      models: { allowed: [], recommended: {} },
      budgets: { defaultTokens: 1000, perAgent: {} },
      readers: "off",
      path: "org-pack/runtime.yaml",
    };
    const h = renderToStaticMarkup(<AiSettingsForm data={data} />);
    expect(h).toContain(esc(COPY.aiSettings.readers("off")));
  });
});
