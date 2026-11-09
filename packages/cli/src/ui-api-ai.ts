import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { parse, parseDocument, stringify } from "yaml";
import { providerFactoryFor, type ModelProvider, type ModelProviderFactory } from "@maycombhq/ai";
import { ASSISTANT_FORMATS, readProbes, whatRunsWhere } from "@maycombhq/assistant-files";
import {
  ASSISTANTS,
  decideOf,
  DEFAULT_RUNTIME,
  loadOrgPack,
  orgPackDirOf,
  Runtime,
  eolOf,
  inEol,
  writeFileIfUnchanged,
  type OrgPack,
} from "@maycombhq/core";
import {
  COMMON_SETTINGS,
  defaultKeyStore,
  keyEnvFromEnvironment,
  looksLikeKey,
  PROVIDER_SETTINGS,
  type KeyStore,
} from "@maycombhq/model-providers";
import { conflict, HttpError, requireConfirmation, type Router } from "@maycombhq/server";
import type { ServerContext } from "@maycombhq/server";
import {
  addressRefusal,
  recordConfirmedAddress,
  whereKeyGoes,
  type ModelSetting,
} from "./model-address.js";

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
  /** This machine's credential store (ADR 0121 item 3). Default: the system's. */
  keys?: KeyStore;
  /** Builds a provider from its type and settings. Default: the registered providers. */
  provider?: (type: string, settings: Record<string, unknown>) => ModelProvider | undefined;
}

const unprocessable = (detail: string) => new HttpError(422, "The settings aren't valid", detail);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/*
 * Review round 48 (ADR 0186): where a model's key goes (whereKeyGoes: its provider, the variable
 * it is read from, every address and the CA that vouches for one) is the person's to confirm in
 * the app. Review round 50: and what they confirm is kept outside the metarepo
 * (model-address.ts), so a run the app starts later sends the key only there.
 */

/** A model setting as JSON with sorted keys, to compare one file's with another's. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** runtime.yaml's model as committed (HEAD), or undefined when it isn't (no Git, no commit). */
function committedModel(file: string): { model: ModelSetting } | undefined {
  try {
    const text = execFileSync("git", ["show", `HEAD:./${basename(file)}`], {
      cwd: dirname(file),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const raw = (parse(text) ?? {}) as { adapters?: { model?: ModelSetting } };
    return { model: raw.adapters?.model };
  } catch {
    return undefined;
  }
}

/** What the tab may change; everything else in runtime.yaml is kept as it is. */
const FIELDS = ["ai", "modes", "assistants", "models", "budgets", "decide"] as const;

export function uiAiRoutes(r: Router, ctx: ServerContext, deps: AiDeps = {}): Router {
  const root = ctx.root;
  const env = deps.env ?? process.env;
  const keys = () => deps.keys ?? defaultKeyStore();
  const file = () => join(orgPackDirOf(root), "runtime.yaml");
  const rel = () => relative(root, file()).split(sep).join("/");
  // A built-in provider, or the org pack's plugin of that id (ADR 0121 item 4), once pinned.
  const build = async (
    op: OrgPack,
    type: string,
    settings: Record<string, unknown>,
  ): Promise<ModelProvider | undefined> => {
    if (deps.provider) return deps.provider(type, settings);
    const make = await providerFactoryFor(op, type);
    return make?.(settings as Parameters<ModelProviderFactory>[0]);
  };

  return (
    r
      .add("GET", "/api/settings/ai", async () => {
        const op = await loadOrgPack(orgPackDirOf(root));
        const rt = op.runtime;
        const model = rt.adapters.model;
        const keyEnv =
          typeof model?.settings.keyEnv === "string" ? model.settings.keyEnv : undefined;
        return {
          status: 200,
          body: {
            // The assistant atticus probe measured here, when one was (ADR 0124 addendum A-probe).
            runs: whatRunsWhere(rt, { probes: (await readProbes(root)).results }),
            ai: rt.ai,
            modes: rt.modes,
            assistants: ASSISTANTS.map((id) => ({
              id,
              name: ASSISTANT_FORMATS[id].name,
              allowed: rt.assistants.allowed.includes(id),
              default: rt.assistants.default === id,
            })),
            providers: [
              ...Object.entries(PROVIDER_SETTINGS).map(([type, settings]) => ({
                type,
                settings: [...settings],
              })),
              // The org pack's model-provider plugins, with what each takes (ADR 0121 item 4).
              ...op.modelProviders.map(({ manifest: m }) => ({
                type: m.id,
                settings: [
                  ...COMMON_SETTINGS,
                  ...(m.auth === "none" ? [] : ["keyEnv"]),
                  ...m.settings,
                ],
                plugin: true,
                pinned: !!m.sha256,
              })),
            ],
            model: model ? { type: model.type, settings: model.settings } : null,
            // Whether the key's variable is set here, by name: its value is never read out.
            // Review round 48: as the provider reads it, the environment only for a model's key.
            keySet: keyEnv
              ? (keyEnvFromEnvironment(keyEnv) && !!env[keyEnv]?.trim()) || !!keys().get(keyEnv)
              : false,
            models: rt.models,
            budgets: rt.budgets,
            // Ninth UX walk (ADR 0181): whether the AI decides first, and the bar that pauses it.
            decide: decideOf(rt),
            schemaVersion: rt.schemaVersion,
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
        // The address the person confirmed with this save, kept once the file is written.
        let confirmedModel: ModelSetting;
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
            // Review round 48: a model's key only, never another secret of this machine's.
            const keyEnv = settings.keyEnv === undefined ? undefined : String(settings.keyEnv);
            if (keyEnv && !keyEnvFromEnvironment(keyEnv) && !keys().get(keyEnv))
              throw unprocessable(
                `keyEnv ${keyEnv} isn't a model's key: name a variable starting ATTICUS_ (such as ATTICUS_MODEL_KEY) or the provider's own (such as ANTHROPIC_API_KEY or OPENAI_API_KEY), or keep the key in this machine's credential store under that name first ("Set the key on this machine", or atticus secret set ${keyEnv}). Another variable (a Git or pipeline token, cloud credentials) is never sent to a model.`,
              );
            adapters.model = { type: m.type, settings };
          }
          // ADR 0186: where the key goes (provider, keyEnv, an address) is the person's to change.
          // Taking the model away sends no key anywhere.
          const was = (raw.adapters as { model?: ModelSetting } | undefined)?.model;
          if (
            adapters.model !== undefined &&
            whereKeyGoes(was) !== whereKeyGoes(adapters.model as ModelSetting)
          ) {
            requireConfirmation(ctx.confirmations, "ai-model", "model", b.confirmation);
            confirmedModel = adapters.model as ModelSetting;
          }
          raw.adapters = adapters;
        }
        // UX review: choosing copilot-acp on a version 2 file lifts it to 3, which only adds the
        // mode (ADR 0171). A version 1 file still needs atticus upgrade first (the message says).
        const names = (m: unknown) => {
          const x = m as { allowed?: unknown[]; default?: unknown } | undefined;
          return [...(x?.allowed ?? []), x?.default].includes("copilot-acp");
        };
        const lifted = names(b.modes) && raw.schemaVersion === 2;
        if (lifted) raw.schemaVersion = 3;
        // Ninth UX walk: decide on a version 3 file lifts it to 4, which only adds decide
        // (ADR 0181, runtime-v4). Older files need atticus upgrade first (the message says).
        const liftedDecide = b.decide !== undefined && raw.schemaVersion === 3;
        if (liftedDecide) raw.schemaVersion = 4;
        const checked = Runtime.safeParse(raw);
        if (!checked.success)
          throw unprocessable(
            checked.error.issues
              .map((i) => `${i.path.join(".") || "runtime.yaml"}: ${i.message}`)
              .join("; "),
          );
        // The person's file keeps its comments (everywhere, not only at the top): the changed keys
        // are set on the document as read; a new file is written as YAML.
        const out = (() => {
          if (text === undefined) return stringify(raw, { lineWidth: 0 });
          const doc = parseDocument(text);
          for (const f of FIELDS) if (b[f] !== undefined) doc.set(f, raw[f]);
          if (b.model !== undefined) doc.set("adapters", raw.adapters);
          if (lifted || liftedDecide) doc.set("schemaVersion", raw.schemaVersion);
          return doc.toString({ lineWidth: 0 });
        })();
        // Only onto the file as read (another window or the CLI meanwhile is a 409), in its own
        // line endings.
        await writeFileIfUnchanged(file(), text, inEol(out, eolOf(text ?? "")));
        // Review round 50: the person confirmed where the key goes: runs the app starts send it
        // there (model-address.ts).
        if (confirmedModel) await recordConfirmedAddress(root, confirmedModel);
        return {
          status: 200,
          body: {
            ok: true,
            path: rel(),
            note: `Saved ${rel()}. Propose it for review: the org pack is reviewed like code.`,
          },
        };
      })
      // Keep the provider's key in this machine's credential store, under keyEnv's name. The key is
      // never written to a file of Atticus's, logged or sent back.
      .add("POST", "/api/settings/ai/key", async ({ body }) => {
        const b = (body ?? {}) as { name?: unknown; value?: unknown };
        const name = typeof b.name === "string" ? b.name.trim() : "";
        const value = typeof b.value === "string" ? b.value.trim() : "";
        if (!ENV_NAME.test(name))
          throw unprocessable(
            "The key's name is keyEnv's: a variable's name, such as ATTICUS_MODEL_KEY.",
          );
        if (!value) throw unprocessable("No key was given.");
        keys().set(name, value);
        return { status: 200, body: { ok: true, name } };
      })
      .add("POST", "/api/settings/ai/test", async ({ body }) => {
        const op = await loadOrgPack(orgPackDirOf(root));
        const model = op.runtime.adapters.model;
        if (!model || model.type === "mock")
          throw conflict("No model provider is set in runtime.yaml: choose one first.");
        // Review round 48 (ADR 0186): Test sends the key at once, so settings that aren't the
        // committed ones are the person's yes. Review round 50: and HEAD alone isn't (the
        // assistant can commit): the address must be the one the person last confirmed (or,
        // with none yet, the provider's own). Confirmed here, it is the confirmed one after.
        const committed = committedModel(file());
        const unconfirmed = await addressRefusal(root, model);
        if (!committed || canonical(committed.model) !== canonical(model) || unconfirmed) {
          requireConfirmation(
            ctx.confirmations,
            "ai-test",
            "model",
            (body as { confirmation?: unknown } | undefined)?.confirmation,
          );
          await recordConfirmedAddress(root, model);
        }
        const started = Date.now();
        try {
          const p = await build(op, model.type, model.settings);
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
      })
  );
}
