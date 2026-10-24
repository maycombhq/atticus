import { useState } from "react";
import { api, useApi, useReloadOnFiles } from "../../api/client.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { Note, useAction } from "./shared.js";

const T = COPY.aiSettings;

/** GET /api/settings/ai (ADR 0121). */
export interface AiSettings {
  ai: string;
  modes: { allowed: string[]; default: string };
  assistants: { id: string; name: string; allowed: boolean; default: boolean }[];
  /** Built-in providers, then the org pack's model-provider plugins (ADR 0121 item 4). */
  providers: { type: string; settings: string[]; plugin?: boolean; pinned?: boolean }[];
  model: { type: string; settings: Record<string, unknown> } | null;
  keySet: boolean;
  models: { allowed: string[]; recommended: Record<string, string> };
  budgets: { defaultTokens: number; perAgent: Record<string, number> };
  path: string;
}

/** What the form holds while a person edits it. */
export interface AiForm {
  ai: string;
  modes: { allowed: string[]; default: string };
  assistants: { allowed: string[]; default: string };
  provider: string;
  settings: Record<string, string>;
  /** The models allowed and the budgets, as typed; sent only when the form has them. */
  limits?: AiLimits;
}

/** The models allowed (one a line) and the budgets (a default, and agent: tokens lines). */
export interface AiLimits {
  models: string;
  /** Kept as they are: the tab doesn't edit the recommended models yet. */
  recommended: Record<string, string>;
  defaultTokens: string;
  perAgent: string;
}

const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/** The limits as runtime.yaml takes them, or the first line that doesn't read. */
export function limitsOf(l: AiLimits):
  | {
      models: { allowed: string[]; recommended: Record<string, string> };
      budgets: { defaultTokens: number; perAgent: Record<string, number> };
    }
  | { error: string } {
  const tokens = /^\d+$/.test(l.defaultTokens.trim()) ? Number(l.defaultTokens.trim()) : NaN;
  if (!Number.isSafeInteger(tokens) || tokens <= 0) return { error: T.badDefaultTokens };
  const perAgent: Record<string, number> = {};
  for (const line of lines(l.perAgent)) {
    const m = /^([a-z0-9][a-z0-9-]*)\s*:\s*(\d+)$/.exec(line);
    if (!m || Number(m[2]) <= 0) return { error: T.badBudgetLine(line) };
    perAgent[m[1]!] = Number(m[2]);
  }
  return {
    models: { allowed: lines(l.models), recommended: l.recommended },
    budgets: { defaultTokens: tokens, perAgent },
  };
}

const MODES = ["hand-off", "model", "headless-claude-code"] as const;
const AI = ["on", "text-only", "off"] as const;

/** The body of PUT /api/settings/ai: only what the tab changes, and no empty settings. */
export function toSave(f: AiForm): Record<string, unknown> {
  const limits = f.limits ? limitsOf(f.limits) : undefined;
  if (limits && "error" in limits) throw new Error(limits.error);
  return {
    ...(limits ?? {}),
    ai: f.ai,
    modes: f.modes,
    assistants: f.assistants,
    model: f.provider
      ? {
          type: f.provider,
          settings: Object.fromEntries(
            Object.entries(f.settings).filter(([, v]) => v.trim() !== ""),
          ),
        }
      : null,
  };
}

const formOf = (d: AiSettings): AiForm => ({
  ai: d.ai,
  modes: d.modes,
  assistants: {
    allowed: d.assistants.filter((a) => a.allowed).map((a) => a.id),
    default: d.assistants.find((a) => a.default)?.id ?? d.assistants[0]?.id ?? "copilot",
  },
  provider: d.model?.type ?? "",
  settings: Object.fromEntries(
    Object.entries(d.model?.settings ?? {}).map(([k, v]) => [k, String(v)]),
  ),
  limits: {
    models: d.models.allowed.join("\n"),
    recommended: d.models.recommended,
    defaultTokens: String(d.budgets.defaultTokens),
    perAgent: Object.entries(d.budgets.perAgent)
      .map(([a, n]) => `${a}: ${n}`)
      .join("\n"),
  },
});

const toggle = (list: string[], id: string, on: boolean) =>
  on ? [...new Set([...list, id])] : list.filter((x) => x !== id);

/**
 * The form: how AI runs, which assistants, the modes, and the model provider with one field per
 * setting it accepts. Save writes runtime.yaml through the local API; Test asks the provider once.
 */
export function AiSettingsForm(p: { data: AiSettings; onSaved?: () => void }) {
  const [f, setF] = useState<AiForm>(() => formOf(p.data));
  const save = useAction();
  const test = useAction();
  const keep = useAction();
  const [key, setKey] = useState("");
  const fields = p.data.providers.find((x) => x.type === f.provider)?.settings ?? [];
  const keyEnv = f.settings.keyEnv?.trim();
  const configured = p.data.model?.type;
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(async () => {
          await api("/api/settings/ai", { method: "PUT", body: toSave(f) });
          p.onSaved?.();
        }, T.saved(p.data.path));
      }}
    >
      <h2 className="h">{T.title}</h2>
      <p className="muted" style={{ margin: 0, maxWidth: "70ch" }}>
        {T.intro}
      </p>

      <fieldset className="stack">
        <legend className="hud">{T.aiLabel}</legend>
        {AI.map((v) => (
          <label key={v} className="row" style={{ gap: 8 }}>
            <input
              type="radio"
              id={`ai-on-${v}`}
              name="ai"
              checked={f.ai === v}
              onChange={() => setF({ ...f, ai: v })}
            />
            {T.ai[v]}
          </label>
        ))}
      </fieldset>

      <fieldset className="stack">
        <legend className="hud">{T.assistantsLabel}</legend>
        <p className="muted" style={{ margin: 0 }}>
          {T.assistantsHint}
        </p>
        {p.data.assistants.map((a) => (
          <label key={a.id} className="row" style={{ gap: 8 }}>
            <input
              type="checkbox"
              id={`ai-assistant-${a.id}`}
              checked={f.assistants.allowed.includes(a.id)}
              onChange={(e) =>
                setF({
                  ...f,
                  assistants: {
                    ...f.assistants,
                    allowed: toggle(f.assistants.allowed, a.id, e.target.checked),
                  },
                })
              }
            />
            {a.name}
          </label>
        ))}
        <label className="row" style={{ gap: 8 }}>
          {T.defaultAssistant}
          <select
            id="ai-default-assistant"
            className="field"
            value={f.assistants.default}
            onChange={(e) =>
              setF({ ...f, assistants: { ...f.assistants, default: e.target.value } })
            }
          >
            {p.data.assistants
              .filter((a) => f.assistants.allowed.includes(a.id))
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
      </fieldset>

      <fieldset className="stack">
        <legend className="hud">{T.modesLabel}</legend>
        {MODES.map((m) => (
          <label key={m} className="row" style={{ gap: 8 }}>
            <input
              type="checkbox"
              id={`ai-mode-${m}`}
              checked={f.modes.allowed.includes(m)}
              onChange={(e) =>
                setF({
                  ...f,
                  modes: { ...f.modes, allowed: toggle(f.modes.allowed, m, e.target.checked) },
                })
              }
            />
            {T.modes[m]}
          </label>
        ))}
        <label className="row" style={{ gap: 8 }}>
          {T.defaultMode}
          <select
            id="ai-default-mode"
            className="field"
            value={f.modes.default}
            onChange={(e) => setF({ ...f, modes: { ...f.modes, default: e.target.value } })}
          >
            {f.modes.allowed.map((m) => (
              <option key={m} value={m}>
                {T.modes[m]}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <fieldset className="stack">
        <legend className="hud">{T.providerLabel}</legend>
        <p className="muted" style={{ margin: 0 }}>
          {T.providerHint}
        </p>
        <select
          id="ai-provider"
          className="field"
          aria-label={T.providerLabel}
          value={f.provider}
          onChange={(e) => setF({ ...f, provider: e.target.value })}
        >
          <option value="">{T.noProvider}</option>
          {p.data.providers.map((x) => (
            <option key={x.type} value={x.type}>
              {x.plugin ? T.pluginProvider(x.type, !!x.pinned) : x.type}
            </option>
          ))}
        </select>
        {fields.map((name) => (
          <label key={name} className="row" style={{ gap: 8 }}>
            <span className="mono" style={{ minWidth: 140 }}>
              {name}
            </span>
            <input
              id={`ai-setting-${name}`}
              className="field"
              value={f.settings[name] ?? ""}
              onChange={(e) => setF({ ...f, settings: { ...f.settings, [name]: e.target.value } })}
            />
          </label>
        ))}
        {keyEnv && configured === f.provider && (
          <p className="muted" style={{ margin: 0 }} role="note">
            {p.data.keySet ? T.keySet(keyEnv) : T.keyNotSet(keyEnv)}
          </p>
        )}
        {keyEnv && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <label htmlFor="ai-key" className="mono">
              {T.keyLabel(keyEnv)}
            </label>
            <input
              id="ai-key"
              type="password"
              className="field"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <button
              type="button"
              className="btn"
              disabled={keep.busy || !key.trim()}
              onClick={() =>
                void keep.run(async () => {
                  await api("/api/settings/ai/key", {
                    method: "POST",
                    body: { name: keyEnv, value: key },
                  });
                  setKey("");
                  p.onSaved?.();
                }, T.keyKept(keyEnv))
              }
            >
              {T.setKey}
            </button>
          </div>
        )}
        <Note note={keep.note} />
      </fieldset>

      {f.limits && (
        <fieldset className="stack">
          <legend className="hud">{T.budgetsLabel}</legend>
          <label className="stack" htmlFor="ai-models">
            <span>{T.modelsLabel}</span>
            <span className="muted">{T.modelsHint}</span>
          </label>
          <textarea
            id="ai-models"
            className="field mono"
            rows={3}
            value={f.limits.models}
            onChange={(e) => setF({ ...f, limits: { ...f.limits!, models: e.target.value } })}
          />
          <label className="row" style={{ gap: 8 }}>
            <span style={{ minWidth: 140 }}>{T.defaultTokensLabel}</span>
            <input
              id="ai-default-tokens"
              className="field mono"
              inputMode="numeric"
              value={f.limits.defaultTokens}
              onChange={(e) =>
                setF({ ...f, limits: { ...f.limits!, defaultTokens: e.target.value } })
              }
            />
          </label>
          <label className="stack" htmlFor="ai-per-agent">
            <span>{T.perAgentLabel}</span>
            <span className="muted">{T.perAgentHint}</span>
          </label>
          <textarea
            id="ai-per-agent"
            className="field mono"
            rows={3}
            value={f.limits.perAgent}
            onChange={(e) => setF({ ...f, limits: { ...f.limits!, perAgent: e.target.value } })}
          />
        </fieldset>
      )}

      <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
        <button type="submit" className="btn primary" disabled={save.busy}>
          {T.save}
        </button>
        {configured && (
          <button
            type="button"
            className="btn"
            disabled={test.busy}
            onClick={() =>
              void test.run(
                () =>
                  api<{ ok: boolean; model?: string; ms?: number; error?: string }>(
                    "/api/settings/ai/test",
                    { method: "POST", body: {} },
                  ).then((r) => {
                    if (!r.ok) throw new Error(T.notAnswered(r.error ?? ""));
                    return r;
                  }),
                (r) => {
                  const a = r as { model?: string; ms?: number };
                  return T.answered(a.model ?? configured, a.ms ?? 0);
                },
              )
            }
          >
            {T.test}
          </button>
        )}
        <span className="muted" style={{ fontSize: 12 }}>
          {T.saveNote(p.data.path)}
        </span>
      </div>
      <Note note={save.note} />
      <Note note={test.note} />
    </form>
  );
}

export function AiSettings() {
  const s = useApi<AiSettings>("/api/settings/ai");
  useReloadOnFiles(s);
  return (
    <div className="bento">
      <Panel title={T.title} span="1 / -1">
        <View of={s}>
          {(d) => <AiSettingsForm key={JSON.stringify(d)} data={d} onSaved={s.reload} />}
        </View>
      </Panel>
    </div>
  );
}
