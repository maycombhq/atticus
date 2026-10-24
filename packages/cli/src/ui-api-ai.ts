import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse, stringify } from "yaml";
import { makeModelProvider, type ModelProvider } from "@maycombhq/ai";
import { ASSISTANT_FORMATS } from "@maycombhq/assistant-files";
import {
  ASSISTANTS,
  DEFAULT_RUNTIME,
  loadOrgPack,
  orgPackDirOf,
  Runtime,
  writeFileAtomic,
} from "@maycombhq/core";
import { looksLikeKey, PROVIDER_SETTINGS } from "@maycombhq/model-providers";
import { conflict, HttpError, type Router } from "@maycombhq/server";
import type { ServerContext } from "@maycombhq/server";

/**
 * The AI tab (ADR 0121): how AI runs here, read from and written to the org pack's runtime.yaml.
 * A write keeps everything it doesn't change, is checked against the Runtime schema, and never
 * takes a key: a provider's key stays in the environment (or the OS's credential store), named
 * by keyEnv. Test asks the configured provider one short question with nothing of the estate in
 * it: the only network call, and only to the configured provider (CLAUDE.md rule 4).
 */

export interface AiDeps {
  /** The environment a provider's key variable is looked up in. Default: this process's. */
  env?: NodeJS.ProcessEnv;
  /** Builds a provider from its type and settings. Default: the registered providers. */
  provider?: (type: string, settings: Record<string, unknown>) => ModelProvider | undefined;
}

const unprocessable = (detail: string) => new HttpError(422, "The settings aren't valid", detail);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** What the tab may change; everything else in runtime.yaml is kept as it is. */
const FIELDS = ["ai", "modes", "assistants", "models", "budgets"] as const;

export function uiAiRoutes(r: Router, ctx: ServerContext, deps: AiDeps = {}): Router {
  const root = ctx.root;
  const env = deps.env ?? process.env;
  const file = () => join(orgPackDirOf(root), "runtime.yaml");
  const rel = () => relative(root, file()).split(sep).join("/");
  const build =
    deps.provider ??
    ((type: string, settings: Record<string, unknown>) =>
      makeModelProvider(type, settings as Parameters<typeof makeModelProvider>[1]));

  return r
    .add("GET", "/api/settings/ai", async () => {
      const rt = (await loadOrgPack(orgPackDirOf(root))).runtime;
      const model = rt.adapters.model;
      const keyEnv = typeof model?.settings.keyEnv === "string" ? model.settings.keyEnv : undefined;
      return {
        status: 200,
        body: {
          ai: rt.ai,
          modes: rt.modes,
          assistants: ASSISTANTS.map((id) => ({
            id,
            name: ASSISTANT_FORMATS[id].name,
            allowed: rt.assistants.allowed.includes(id),
            default: rt.assistants.default === id,
          })),
          providers: Object.entries(PROVIDER_SETTINGS).map(([type, settings]) => ({
            type,
            settings: [...settings],
          })),
          model: model ? { type: model.type, settings: model.settings } : null,
          // Whether the key's variable is set here, by name: its value is never read out.
          keySet: keyEnv ? !!env[keyEnv] : false,
          models: rt.models,
          budgets: rt.budgets,
          path: rel(),
        },
      };
    })
    .add("PUT", "/api/settings/ai", async ({ body }) => {
      const b = (body ?? {}) as Record<string, unknown>;
      const text = existsSync(file()) ? await readFile(file(), "utf8") : undefined;
      const raw = (
        text !== undefined ? (parse(text) ?? {}) : structuredClone(DEFAULT_RUNTIME)
      ) as Record<string, unknown>;
      for (const f of FIELDS) if (b[f] !== undefined) raw[f] = b[f];
      if (b.model !== undefined) {
        const adapters = { ...((raw.adapters as Record<string, unknown>) ?? {}) };
        if (b.model === null) delete adapters.model;
        else {
          const m = b.model as { type?: unknown; settings?: Record<string, unknown> };
          const settings = Object.fromEntries(
            Object.entries(m.settings ?? {}).filter(([, v]) => v !== "" && v !== undefined),
          );
          for (const [name, v] of Object.entries(settings))
            for (const one of Array.isArray(v) ? v : [v])
              if (typeof one === "string" && looksLikeKey(one))
                throw unprocessable(
                  `${name} looks like a key. A key never goes in runtime.yaml: keep it in an environment variable (or the OS's credential store) and give that variable's name as keyEnv.`,
                );
          if (settings.keyEnv !== undefined && !ENV_NAME.test(String(settings.keyEnv)))
            throw unprocessable(
              `keyEnv is the name of an environment variable, such as ATTICUS_MODEL_KEY.`,
            );
          adapters.model = { type: m.type, settings };
        }
        raw.adapters = adapters;
      }
      const checked = Runtime.safeParse(raw);
      if (!checked.success)
        throw unprocessable(
          checked.error.issues
            .map((i) => `${i.path.join(".") || "runtime.yaml"}: ${i.message}`)
            .join("; "),
        );
      // Keep the file's own opening comments; write the rest as YAML.
      const header = (text ?? "")
        .split(/\r?\n/)
        .filter((l, i, a) => a.slice(0, i + 1).every((x) => x.startsWith("#")));
      await writeFileAtomic(
        file(),
        `${header.length ? `${header.join("\n")}\n` : ""}${stringify(raw, { lineWidth: 0 })}`,
      );
      return {
        status: 200,
        body: {
          ok: true,
          path: rel(),
          note: `Saved ${rel()}. Commit it in a pull request: the org pack is reviewed like code.`,
        },
      };
    })
    .add("POST", "/api/settings/ai/test", async () => {
      const model = (await loadOrgPack(orgPackDirOf(root))).runtime.adapters.model;
      if (!model || model.type === "mock")
        throw conflict("No model provider is set in runtime.yaml: choose one first.");
      const started = Date.now();
      try {
        const p = build(model.type, model.settings);
        if (!p)
          return {
            status: 200,
            body: { ok: false, error: `No ${model.type} provider is installed here.` },
          };
        await p.complete({
          system: "You are checking that a connection works.",
          prompt: "Reply with the word OK.",
          maxOutputTokens: 5,
        });
        return { status: 200, body: { ok: true, model: p.model, ms: Date.now() - started } };
      } catch (e) {
        return {
          status: 200,
          body: { ok: false, error: e instanceof Error ? e.message : String(e) },
        };
      }
    });
}
