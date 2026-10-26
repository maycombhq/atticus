import { readdir } from "node:fs/promises";
import { changesDirOf } from "@maycombhq/core";
import { runOpenSpecRaw } from "@maycombhq/openspec-adapter";
import type { Output } from "./commands.js";

/**
 * `atticus openspec <args...>` (ADR 0006 addendum 2026-10-26): the bundled OpenSpec CLI, run in
 * the metarepo with the arguments as they are. `openspec` is not on PATH — it ships inside the
 * installed Atticus package — so every OpenSpec command Atticus names in a message is runnable as
 * `atticus openspec <the same words>`. Atticus parses nothing: OpenSpec's own output and exit code
 * come straight back.
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

export async function openspecRun(root: string, args: string[], io: Output): Promise<number> {
  if (!args.length) {
    io.err(
      "Usage: atticus openspec <openspec arguments>, for example: atticus openspec status, atticus openspec instructions apply. atticus openspec setup and atticus openspec check are Atticus's own.",
    );
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
