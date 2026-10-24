import { defaultKeyStore, type KeyStore } from "@maycombhq/model-providers";
import type { Output } from "./commands.js";

/**
 * atticus secret set|check|forget <name> (ADR 0121 item 3): a model provider's key kept in this
 * machine's credential store under the name runtime.yaml gives as keyEnv. The key is read from
 * stdin, never from a command line, and never printed: only its name is.
 */

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export interface SecretDeps {
  store?: KeyStore;
  env?: NodeJS.ProcessEnv;
  /** The key, as typed or piped in. */
  read?: () => Promise<string>;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin)
    chunks.push(typeof c === "string" ? Buffer.from(c) : (c as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

export async function secretCommand(
  args: string[],
  io: Output,
  deps: SecretDeps = {},
): Promise<number> {
  const [verb, name] = args;
  const store = deps.store ?? defaultKeyStore();
  const env = deps.env ?? process.env;
  if (!verb || !["set", "check", "forget"].includes(verb) || !name) {
    io.err("Usage: atticus secret set|check|forget <name>, the name runtime.yaml gives as keyEnv.");
    return 2;
  }
  if (!NAME.test(name)) {
    io.err(
      `${name} isn't a variable's name: use letters, digits and _, such as ATTICUS_MODEL_KEY.`,
    );
    return 2;
  }
  if (verb === "set") {
    if (process.stdin.isTTY && !deps.read)
      io.out(`Paste the key for ${name}, then press Enter and Ctrl+Z (Windows) or Ctrl+D:`);
    const value = (await (deps.read ?? readStdin)()).trim();
    if (!value) {
      io.err("No key was given: pipe it in, for example from your password manager.");
      return 2;
    }
    try {
      store.set(name, value);
    } catch (e) {
      io.err(e instanceof Error ? e.message : String(e));
      return 1;
    }
    io.out(`Kept ${name} in this machine's credential store. runtime.yaml names it as keyEnv.`);
    return 0;
  }
  if (verb === "forget") {
    store.forget(name);
    io.out(`${name} is no longer kept on this machine.`);
    return 0;
  }
  if (env[name]?.trim()) {
    io.out(`${name} is set in the environment (it is used before the credential store).`);
    return 0;
  }
  if (store.get(name)) {
    io.out(`${name} is kept in this machine's credential store.`);
    return 0;
  }
  io.out(`${name} isn't set on this machine: atticus secret set ${name} keeps it.`);
  return 1;
}
