import { AsyncLocalStorage } from "node:async_hooks";
import { loadOrgPack, orgPackDirOf } from "@maycombhq/core";
import { readUserState, writeUserState } from "./user-state.js";

/**
 * Review round 50 (ADR 0186 addendum): where the model's key goes is the person's. runtime.yaml
 * is the assistant's to edit, and to commit, so neither the working tree nor HEAD says where the
 * person agreed to send their key. The address the person last confirmed is kept outside the
 * metarepo (the user's state folder, per metarepo, user-state.ts), and a run that no person
 * started at a terminal sends the key only there.
 *
 * Who confirms an address, and when:
 * - in the app: a save of the AI settings that changes where the key goes (its `ai-model`
 *   confirmation), and Test (its `ai-test` confirmation);
 * - at a terminal: a step the person runs in model mode in their own terminal (outside a Copilot
 *   session, not from the app, with a terminal on standard input) sends the key where
 *   runtime.yaml says, as it always has, and that address is then the confirmed one.
 *
 * Who is held to it: every model call the app starts (any route, any job it runs), and every
 * step a Copilot session Atticus started runs (ATTICUS_ACP_SESSION). Refused, nothing is built,
 * so no key is read: the app answers 403, the command line exits 2. With nothing confirmed yet,
 * a built-in provider's own address (no baseUrl, endpoint or caFile: Anthropic's API, Bedrock's
 * regional one) is taken; any other asks first. Scripts and CI (no terminal, no session, not the
 * app) run as before: their runtime.yaml is the committed, reviewed one.
 */

/** Where the key goes: its provider, the variable it is read from, every address and the CA. */
export type ModelSetting = { type?: unknown; settings?: Record<string, unknown> } | undefined;

const ADDRESS = /url|endpoint|host|address/i;

export function whereKeyGoes(m: ModelSetting): string {
  const s = m?.settings ?? {};
  const picked = Object.keys(s)
    .filter((k) => k === "keyEnv" || k === "caFile" || ADDRESS.test(k))
    .sort()
    .map((k) => [k, s[k]]);
  return JSON.stringify([m?.type ?? null, picked]);
}

/** The addresses, for the person to read in a refusal: `anthropic at http://…`. */
function addressWords(m: ModelSetting): string {
  const s = m?.settings ?? {};
  const at = Object.keys(s)
    .filter((k) => k === "caFile" || ADDRESS.test(k))
    .map((k) => `${k} ${String(s[k])}`);
  return `${String(m?.type ?? "no provider")}${at.length ? ` (${at.join(", ")})` : " at its own address"}`;
}

/** The built-in providers whose own address is fixed (no address setting needed). */
const OWN_ADDRESS = new Set(["anthropic", "bedrock"]);

/** A built-in provider at its own address: nothing in the settings says where to send the key. */
export function atProvidersOwnAddress(m: ModelSetting): boolean {
  if (typeof m?.type !== "string" || !OWN_ADDRESS.has(m.type)) return false;
  return !Object.keys(m.settings ?? {}).some((k) => k === "caFile" || ADDRESS.test(k));
}

const FILE = "model-address.json";

/** The address the person last confirmed for this metarepo, or undefined. */
export async function confirmedAddress(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const r = await readUserState<{ address?: unknown }>(root, FILE, env);
  return typeof r?.address === "string" ? r.address : undefined;
}

/** Keep this model's address as the one the person confirmed. */
export async function recordConfirmedAddress(
  root: string,
  m: ModelSetting,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await writeUserState(root, FILE, { address: whereKeyGoes(m), at: new Date().toISOString() }, env);
}

/** Why this model's key may not be sent from a run no person started, or undefined when it may. */
export async function addressRefusal(
  root: string,
  m: ModelSetting,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (!m || m.type === undefined || m.type === "mock") return undefined;
  const confirmed = await confirmedAddress(root, env);
  const ok = confirmed !== undefined ? confirmed === whereKeyGoes(m) : atProvidersOwnAddress(m);
  if (ok) return undefined;
  return `runtime.yaml sends the model's key to ${addressWords(m)}, which you haven't confirmed${confirmed !== undefined ? " (it changed since you last did)" : ""}, so nothing was sent. Open AI settings in the Atticus app and press Test: it asks you to confirm where the key goes. Or run the step yourself in a terminal (ADR 0186).`;
}

// ---- Who started the run.

const fromApp = new AsyncLocalStorage<true>();
let serving = 0;

/** Run `f` as the app: every model call it starts, however deep, is held to the confirmed address. */
export const asTheApp = <T>(f: () => T): T => fromApp.run(true, f);

/** This process is `atticus ui`: every model call in it is the app's (on while the server runs). */
export function servingTheApp(on: boolean): void {
  serving = Math.max(0, serving + (on ? 1 : -1));
}

export type Starter = "app" | "session" | "person" | "unattended";

export function whoStarts(
  env: NodeJS.ProcessEnv = process.env,
  tty: boolean = process.stdin.isTTY === true,
): Starter {
  if (fromApp.getStore() || serving > 0) return "app";
  if (env.ATTICUS_ACP_SESSION) return "session";
  return tty ? "person" : "unattended";
}

/** The refusal's error: a RuntimeConfigError, so the command line exits 2 with its words. */
async function refusalError(message: string): Promise<Error> {
  const { RuntimeConfigError } = await import("@maycombhq/ai");
  const e = new RuntimeConfigError(message);
  return Object.assign(e, { modelAddress: true });
}

/**
 * The guard the command line registers with the AI runtime (registerModelGuard): asked before
 * a model provider is made.
 */
export async function guardModelAddress(
  o: { root: string; type: string; settings: Record<string, unknown> },
  env: NodeJS.ProcessEnv = process.env,
  tty: boolean = process.stdin.isTTY === true,
): Promise<void> {
  // `env` says who runs the step; the state folder is this process's own (its environment).
  const who = whoStarts(env, tty);
  if (who === "unattended") return;
  const m = { type: o.type, settings: o.settings };
  if (who === "person") {
    if ((await confirmedAddress(o.root)) !== whereKeyGoes(m))
      await recordConfirmedAddress(o.root, m).catch(() => undefined);
    return;
  }
  const no = await addressRefusal(o.root, m);
  if (no) throw await refusalError(no);
}

/**
 * For a route that starts a model run: 403 before anything starts when the mode in effect is
 * model and runtime.yaml's address isn't the confirmed one.
 */
export async function requireConfirmedModel(
  root: string,
  mode: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const op = await loadOrgPack(orgPackDirOf(root));
  const effective = mode ?? env.ATTICUS_RUNTIME ?? op.runtime.modes.default;
  if (effective !== "model") return;
  const no = await addressRefusal(root, op.runtime.adapters.model, env);
  if (!no) return;
  // Loaded here: the command line's guard above loads nothing of the server.
  const { HttpError } = await import("@maycombhq/server");
  throw new HttpError(403, "Confirm where the model's key goes", no, { confirm: "ai-test" });
}
