import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import {
  AiSettingsForm,
  limitsOf,
  toSave,
  type AiSettings,
} from "../src/screens/run/AiSettings.js";
import { screenOf } from "../src/app/screens.js";

/** The AI tab (ADR 0121): how AI runs here, chosen in a form instead of runtime.yaml by hand. */

const T = COPY.aiSettings;
const html = (n: React.ReactElement) => renderToStaticMarkup(n);

const DATA: AiSettings = {
  ai: "on",
  modes: { allowed: ["hand-off"], default: "hand-off" },
  assistants: [
    { id: "copilot", name: "GitHub Copilot", allowed: true, default: true },
    { id: "claude-code", name: "Claude Code", allowed: true, default: false },
    { id: "cursor", name: "Cursor", allowed: false, default: false },
  ],
  providers: [
    { type: "anthropic", settings: ["model", "keyEnv", "baseUrl"] },
    { type: "bedrock", settings: ["model", "region"] },
  ],
  model: null,
  keySet: false,
  models: { allowed: [], recommended: {} },
  budgets: { defaultTokens: 200000, perAgent: {} },
  path: "org-pack/runtime.yaml",
};

describe("the AI tab (ADR 0121)", () => {
  it("is a tab of Set up", () => {
    expect(screenOf("#/ai")).toMatchObject({ id: "ai", section: "SetUp" });
  });

  it("shows how AI runs, every assistant to tick, the modes and the provider's fields", () => {
    const out = html(<AiSettingsForm data={DATA} />);
    expect(out).toContain(T.title);
    for (const a of ["GitHub Copilot", "Claude Code", "Cursor"]) expect(out).toContain(a);
    expect(out).toMatch(
      /type="checkbox"[^>]*checked=""[^>]*id="ai-assistant-copilot"|id="ai-assistant-copilot"[^>]*checked=""/,
    );
    expect(out).toContain(esc(T.modes["hand-off"]!));
    expect(out).toContain(esc(T.modes.model!));
    expect(out).toContain(esc(T.noProvider));
    expect(out).toContain(esc(T.saveNote("org-pack/runtime.yaml")));
  });

  it("shows the chosen provider's own settings, one field each, and whether its key is set by name", () => {
    const out = html(
      <AiSettingsForm
        data={{
          ...DATA,
          modes: { allowed: ["hand-off", "model"], default: "hand-off" },
          model: {
            type: "anthropic",
            settings: { model: "claude-opus-5-5", keyEnv: "ATTICUS_MODEL_KEY" },
          },
          keySet: true,
        }}
      />,
    );
    expect(out).toContain('id="ai-setting-model"');
    expect(out).toContain('id="ai-setting-keyEnv"');
    expect(out).toContain('id="ai-setting-baseUrl"');
    expect(out).not.toContain('id="ai-setting-region"');
    expect(out).toContain(esc(T.keySet("ATTICUS_MODEL_KEY")));
    // The key itself is typed into a password field and kept on this machine, never in the file.
    expect(out).toMatch(/id="ai-key" type="password"/);
    expect(out).toContain(esc(T.setKey));
    expect(out).toContain(T.test);
  });

  it("names the org pack's provider plugins, and says when one isn't pinned (ADR 0121 item 4)", () => {
    const out = html(
      <AiSettingsForm
        data={{
          ...DATA,
          providers: [
            ...DATA.providers,
            {
              type: "vertex",
              settings: ["model", "keyEnv", "project", "region"],
              plugin: true,
              pinned: true,
            },
            { type: "northwind-gateway", settings: ["model"], plugin: true, pinned: false },
          ],
        }}
      />,
    );
    expect(out).toContain(esc(T.pluginProvider("vertex", true)));
    expect(out).toContain(esc(T.pluginProvider("northwind-gateway", false)));
    expect(T.pluginProvider("northwind-gateway", false)).toContain(
      "atticus plugin pin northwind-gateway",
    );
  });

  it("edits the models allowed and the budgets, keeping the recommended models (ADR 0121)", () => {
    const base = {
      ai: "on",
      modes: { allowed: ["hand-off"], default: "hand-off" },
      assistants: { allowed: ["copilot"], default: "copilot" },
      provider: "",
      settings: {},
    };
    const saved = toSave({
      ...base,
      limits: {
        models: "claude-opus-5-5\n\n  gemini-2.5-pro \n",
        recommended: { architect: "claude-opus-5-5" },
        defaultTokens: "150000",
        perAgent: "architect: 300000\nplanner:80000\n",
      },
    });
    expect(saved.models).toEqual({
      allowed: ["claude-opus-5-5", "gemini-2.5-pro"],
      recommended: { architect: "claude-opus-5-5" },
    });
    expect(saved.budgets).toEqual({
      defaultTokens: 150000,
      perAgent: { architect: 300000, planner: 80000 },
    });
    // Without the limits, the tab sends neither, and runtime.yaml keeps them.
    expect(toSave(base)).not.toHaveProperty("budgets");
  });

  it("says which budget line doesn't read, and shows the form's fields for them", () => {
    expect(limitsOf({ models: "", recommended: {}, defaultTokens: "lots", perAgent: "" })).toEqual({
      error: T.badDefaultTokens,
    });
    expect(
      limitsOf({
        models: "",
        recommended: {},
        defaultTokens: "1000",
        perAgent: "architect 300000",
      }),
    ).toEqual({ error: T.badBudgetLine("architect 300000") });
    const out = html(
      <AiSettingsForm data={{ ...DATA, models: { allowed: ["m-1"], recommended: {} } }} />,
    );
    expect(out).toContain(esc(T.modelsLabel));
    expect(out).toContain(esc(T.budgetsLabel));
    expect(out).toContain("m-1");
    expect(out).toContain("200000");
  });

  it("sends only what the tab changes, and no empty settings", () => {
    expect(
      toSave({
        ai: "on",
        modes: { allowed: ["hand-off", "model"], default: "model" },
        assistants: { allowed: ["copilot", "cursor"], default: "copilot" },
        provider: "anthropic",
        settings: { model: "claude-opus-5-5", keyEnv: "ATTICUS_MODEL_KEY", baseUrl: "" },
      }),
    ).toEqual({
      ai: "on",
      modes: { allowed: ["hand-off", "model"], default: "model" },
      assistants: { allowed: ["copilot", "cursor"], default: "copilot" },
      model: {
        type: "anthropic",
        settings: { model: "claude-opus-5-5", keyEnv: "ATTICUS_MODEL_KEY" },
      },
    });
    expect(
      toSave({
        ai: "off",
        modes: { allowed: ["hand-off"], default: "hand-off" },
        assistants: { allowed: ["copilot"], default: "copilot" },
        provider: "",
        settings: {},
      }).model,
    ).toBeNull();
  });
});

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
