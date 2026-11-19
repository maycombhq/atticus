import { readdir } from "node:fs/promises";
import { changesDirOf } from "@maycombhq/core";
import { runOpenSpecRaw } from "@maycombhq/openspec-adapter";
import type { Output } from "./commands.js";

/**
 * `atticus openspec <args...>` (ADR 0006 addendum 2026-10-26): the bundled OpenSpec CLI, run in
 * the metarepo with the arguments as they are. `openspec` is not on PATH — it ships inside the
 * installed Atticus package — so every OpenSpec command Atticus names in a message is runnable as
 * `atticus openspec <the same words>`. OpenSpec's own output and exit code come straight back.
 * It runs only what reads the metarepo and writes nothing (`ALLOWED`); anything else is refused
 * before OpenSpec runs, with what Atticus runs instead.
 *
 * The one thing it fills in: `status` with no `--change` is OpenSpec's error, though a metarepo
 * normally has one change open. When exactly one change is open, the wrapper adds `--change <id>`
 * and says it did, so nobody is stopped by a flag Atticus could work out.
 */

const CHANGE_FLAG = (a: string) =>
  a === "--change" || a === "-c" || a.startsWith("--change=") || a.startsWith("-c=");

/** The changes open in the metarepo (openspec/changes/, without archive/). */
async function openChanges(root: string): Promise<string[]> {
  return (await readdir(changesDirOf(root), { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory() && d.name !== "archive")
    .map((d) => d.name)
    .sort();
}

/** The commands of OpenSpec that take `--change` and say so when it is missing. */
const NEEDS_CHANGE = new Set(["status", "instructions", "show"]);

/**
 * What `atticus openspec` runs (the review of b30/proof-fixes): the commands that read the
 * metarepo and write nothing, each with the options it takes (`true` takes a value) and how many
 * names it takes. Anything else is refused before OpenSpec runs, with what Atticus runs instead:
 * a command that writes outside the metarepo, changes it behind Atticus's back, or reaches the
 * network. The hand-off's own `validate` call goes through the adapter, not here.
 */
const ALLOWED: Record<string, { options: Record<string, boolean>; names: number }> = {
  validate: {
    options: {
      "--all": false,
      "--changes": false,
      "--specs": false,
      "--archived": false,
      "--report": true,
      "--type": true,
      "--strict": false,
      "--json": false,
      "--concurrency": true,
      "--no-interactive": false,
    },
    names: 1,
  },
  list: {
    options: {
      "--specs": false,
      "--changes": false,
      "--archived": false,
      "--all": false,
      "--sort": true,
      "--json": false,
    },
    names: 0,
  },
  show: {
    options: {
      "--json": false,
      "--type": true,
      "--no-interactive": false,
      "--deltas-only": false,
      "--requirements-only": false,
      "--diff": false,
      "--requirements": false,
      "--no-scenarios": false,
      "--requirement": true,
      "-r": true,
      // Filled in by Atticus when one change is open.
      "--change": true,
    },
    names: 1,
  },
  view: { options: {}, names: 0 },
  status: {
    options: { "--change": true, "--all": false, "--schema": true, "--json": false },
    names: 0,
  },
  instructions: { options: { "--change": true, "--schema": true, "--json": false }, names: 1 },
  templates: { options: { "--schema": true, "--json": false }, names: 0 },
  schemas: { options: { "--json": false }, names: 0 },
  version: { options: { "--json": false }, names: 0 },
  doctor: { options: { "--json": false }, names: 0 },
  help: { options: {}, names: 1 },
};
/** Taken anywhere, as OpenSpec takes them. */
const ANYWHERE = new Set(["--no-color", "-h", "--help"]);

/** What Atticus runs instead of an OpenSpec command it doesn't pass on. */
const INSTEAD: Record<string, string> = {
  init: "Atticus sets OpenSpec up in the metarepo itself: atticus openspec setup.",
  update: "Atticus brings the metarepo's OpenSpec files up to date: atticus upgrade.",
  archive:
    "Atticus archives a change with its gates, its record and a rescan: atticus change archive <id>.",
  new: "Atticus makes a change with its record and its type: atticus change new.",
  change: "Atticus keeps the change's record: atticus change list, atticus change status <id>.",
  spec: "Atticus accepts a seeded spec with its checks: atticus spec accept <repo>.",
  schema: "The metarepo's schema is Atticus's: atticus openspec setup writes it.",
  config:
    "It changes OpenSpec's own configuration on this machine, outside the metarepo. Run the openspec command yourself if you mean to.",
  completion:
    "It changes your shell's set-up, outside the metarepo. Run the openspec command yourself if you mean to.",
  store: "It registers other roots on this machine, outside the metarepo.",
  workset: "It writes views on this machine, outside the metarepo.",
  feedback: "It reaches the network: the only network call Atticus makes is to the model provider.",
};

/** Why `args` isn't run, or undefined when it is one `atticus openspec` passes on. */
function refusal(args: readonly string[]): string | undefined {
  const [command, ...rest] = args;
  if (command === "--version" || command === "-V" || ANYWHERE.has(command!))
    return rest.length ? `${command} takes nothing after it.` : undefined;
  if (!command || command.startsWith("-"))
    return `${command ?? "Nothing"} isn't an OpenSpec command atticus openspec runs.`;
  const allowed = ALLOWED[command];
  if (!allowed)
    return `openspec ${command} isn't one atticus openspec runs: it writes, or reaches outside the metarepo. ${INSTEAD[command] ?? "atticus help openspec lists the commands it runs."}`;
  let names = 0;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("-")) {
      names += 1;
      if (names > allowed.names)
        return allowed.names
          ? `openspec ${command} takes one name; ${rest.filter((x) => !x.startsWith("-")).join(", ")} are more.`
          : `openspec ${command} takes no name; ${a} is one.`;
      continue;
    }
    const [flag, given] = a.includes("=") ? [a.slice(0, a.indexOf("=")), true] : [a, false];
    if (flag === "--store")
      return "--store runs OpenSpec on another root than this metarepo: atticus openspec runs only here.";
    if (flag === "--check" && command === "version")
      return "version --check reaches the network: the only network call Atticus makes is to the model provider.";
    if (ANYWHERE.has(flag)) continue;
    if (!(flag in allowed.options))
      return `${flag} isn't one atticus openspec passes on to openspec ${command}: it takes ${Object.keys(allowed.options).join(", ") || "no option"}.`;
    if (allowed.options[flag] && !given) i += 1;
  }
  return undefined;
}

export async function openspecRun(root: string, args: string[], io: Output): Promise<number> {
  if (!args.length) {
    io.err(
      "Usage: atticus openspec <openspec arguments>, for example: atticus openspec status, atticus openspec instructions apply. atticus openspec setup and atticus openspec check are Atticus's own.",
    );
    return 2;
  }
  const why = refusal(args);
  if (why) {
    io.err(why);
    io.err("Nothing was run.");
    return 2;
  }
  let full = [...args];
  let note: string | undefined;
  if (NEEDS_CHANGE.has(args[0]!) && !args.some(CHANGE_FLAG)) {
    const changes = await openChanges(root);
    if (changes.length === 1) {
      full = [...full, "--change", changes[0]!];
      note = `Only one change is open, so: openspec ${full.join(" ")}`;
    } else if (changes.length > 1)
      note = `${changes.length} changes are open (${changes.join(", ")}); add --change <id> to name one.`;
  }
  if (note) io.out(note);
  const r = await runOpenSpecRaw(full, { root });
  for (const l of r.stdout.replace(/\n$/, "").split("\n")) if (l !== "") io.out(l);
  for (const l of r.stderr.replace(/\n$/, "").split("\n")) if (l !== "") io.err(l);
  return r.exitCode ?? 1;
}
