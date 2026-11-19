import { AsyncLocalStorage } from "node:async_hooks";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { catalogDirOf, type Api } from "@maycombhq/core";
import type { BuildRefusal } from "@maycombhq/scanner";
import type { Output } from "./commands.js";
import { isMetarepo } from "./metarepo-guard.js";
import { installCommand, VERSION } from "./version.js";

/**
 * ADR 0202 point 8: where a metarepo stands against this Atticus, and the one thing to do about
 * it. One function, `standing(root)`, gives the parts and the one line made of them:
 * `atticus status` prints it, GET /api/status serves it, and every command that refuses a build,
 * an upgrade or a write ends with it (`refusalEnds`), so nobody has to work out which of three
 * versions is behind (their Atticus, the metarepo, the catalog) before they know what to type.
 */

/** Every word of the line (ADR 0202: the command line's words, in one constant by its command). */
export const STANDING_WORDS = {
  on: (x: string) => `You are on Atticus ${x}.`,
  noMetarepo: "This folder isn't an Atticus metarepo.",
  stamp: (y: string) => `This metarepo is at ${y} (.atticus/metarepo.yaml)`,
  noStamp: "This metarepo has no stamp yet",
  stampUnread: "This metarepo's stamp is one this Atticus can't read",
  catalogBuiltBy: (z: string) => `, and its catalog was built by Atticus ${z}.`,
  catalogRead: ", and this Atticus reads its catalog.",
  catalogNewer: ", and its catalog was built by a newer Atticus.",
  catalogNone: ", and it has no catalog yet.",
  extension: (w: string) => `The extension needs ${w}.`,
  act: (command: string) => `Do: ${command}`,
  nothing: "Nothing to do.",
  steps: (n: number) => (n === 1 ? "1 upgrade step waits." : `${n} upgrade steps wait.`),
  init: "atticus init <folder>",
  sandbox: "cd metarepo",
  upgrade: "atticus upgrade",
} as const;

/** The environment variable the editor's extension sets: the Atticus it needs. */
export const EXTENSION_NEEDS = "ATTICUS_EXTENSION_NEEDS";

/** The shape of an Atticus version: the only value that goes into a command a person copies. */
const A_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
const versionOf = (v: string | undefined): string | undefined =>
  v && A_VERSION.test(v.trim()) ? v.trim() : undefined;

async function hasFile(dir: string): Promise<boolean> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => []))
    if (e.isFile() || (e.isDirectory() && (await hasFile(join(dir, e.name))))) return true;
  return false;
}

/**
 * Whether the catalog still waits to be adopted into source slots (`atticus upgrade`'s last
 * step, the build's `not-upgraded`): record files under catalog/generated, and no build.json or
 * slot under catalog/sources. Told from the folders alone; no record is read.
 */
async function slotsStepWaits(root: string): Promise<boolean> {
  const sources = join(catalogDirOf(root), "sources");
  if (
    await stat(join(sources, "build.json")).then(
      () => true,
      () => false,
    )
  )
    return false;
  for (const sub of ["readers", "facts", "legacy"])
    if (await hasFile(join(sources, sub))) return false;
  return hasFile(join(catalogDirOf(root), "generated"));
}

export interface StandingOptions {
  /** This Atticus (a test's). */
  version?: string;
  /** Where ATTICUS_EXTENSION_NEEDS is read (a test's). */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * After a refusal: without the upgrade steps' dry runs, which read every record. A step then
   * counts as pending when the stamp doesn't name its id.
   */
  quick?: boolean;
}

export async function standing(root: string, o: StandingOptions = {}): Promise<Api.StandingViewT> {
  const W = STANDING_WORDS;
  const atticus = o.version ?? VERSION;
  const needs = versionOf((o.env ?? process.env)[EXTENSION_NEEDS]);
  const ext = needs ? { extensionNeeds: needs } : {};
  const line = (parts: (string | undefined)[], act: string | undefined) =>
    [W.on(atticus), ...parts, needs ? W.extension(needs) : undefined, act ? W.act(act) : W.nothing]
      .filter(Boolean)
      .join(" ");
  if (!isMetarepo(root)) {
    const act = isMetarepo(join(root, "metarepo")) ? W.sandbox : W.init;
    return {
      atticus,
      state: "no-metarepo",
      catalog: "none",
      ...ext,
      pendingSteps: 0,
      do: act,
      line: line([W.noMetarepo], act),
    };
  }
  const up = await import("./upgrade.js");
  const [c, newerCatalog, slotsWait] = await Promise.all([
    o.quick ? up.upgradeCheckQuick(root, atticus) : up.upgradeCheck(root, atticus),
    up.newerCatalogOf(root),
    slotsStepWaits(root),
  ]);
  const pendingSteps = c.pending.length + (slotsWait ? 1 : 0);
  const builtBy = versionOf(newerCatalog?.files.find((f) => f.atticus)?.atticus);
  const catalog: Api.StandingViewT["catalog"] = newerCatalog
    ? "newer"
    : (await hasFile(join(catalogDirOf(root), "generated"))) ||
        (await hasFile(join(catalogDirOf(root), "sources")))
      ? "read"
      : "none";
  const stampPart = c.stamp ? W.stamp(c.stamp.atticus) : c.unreadStamp ? W.stampUnread : W.noStamp;
  const catalogPart = builtBy
    ? W.catalogBuiltBy(builtBy)
    : catalog === "newer"
      ? W.catalogNewer
      : catalog === "read"
        ? W.catalogRead
        : W.catalogNone;
  // The first case that holds decides the state and the one command.
  let state: Api.StandingViewT["state"] = "up-to-date";
  let act: string | undefined;
  const needsNewer = !!needs && up.newerThan(needs, atticus);
  if (newerCatalog) {
    state = "catalog-newer";
    act = (await import("@maycombhq/scanner")).newerAtticusCommand(newerCatalog.files);
  } else if (c.newer || needsNewer) {
    state = "atticus-behind";
    // The newer of the stamp's Atticus and the extension's; `@beta` when neither is known.
    const y = c.newer ? versionOf(up.newerAtticusOf(c)) : undefined;
    const w = needsNewer ? needs : undefined;
    act = installCommand((y && w ? (up.newerThan(w, y) ? w : y) : (y ?? w)) ?? "beta");
  } else if (!c.stamp || up.newerThan(atticus, c.stamp.atticus) || pendingSteps > 0) {
    state = "metarepo-behind";
    act = W.upgrade;
  }
  return {
    atticus,
    state,
    ...(c.stamp ? { stamp: c.stamp.atticus } : {}),
    ...(c.unreadStamp ? { stampUnread: true as const } : {}),
    catalog,
    ...(builtBy ? { catalogBuiltBy: builtBy } : {}),
    ...ext,
    pendingSteps,
    ...(act ? { do: act } : {}),
    line: line([`${stampPart}${catalogPart}`], act),
  };
}

/** atticus status [--json]: the line, then the steps that wait. 0 when up to date, else 1. */
export async function statusCommand(
  root: string,
  o: { json?: boolean },
  io: Output,
  s: StandingOptions = {},
): Promise<number> {
  const v = await standing(root, s);
  if (o.json) io.out(JSON.stringify(v, null, 2));
  else {
    io.out(v.line);
    if (v.pendingSteps) io.out(STANDING_WORDS.steps(v.pendingSteps));
  }
  return v.state === "up-to-date" ? 0 : 1;
}

// ------------------------------------------------------------------ the line after every refusal

/** One command's run: whether it refused, the line to end with, and the build's refusal. */
interface RefusalRun {
  line?: string;
  build?: BuildRefusal;
}
const runs = new AsyncLocalStorage<RefusalRun>();

/**
 * Run one command (the command line's `main`, a route's job) so that a refusal in it ends with
 * the standing line: `done` prints it, last, on standard error, when the command refused.
 */
export async function refusalScope<T>(io: Pick<Output, "err">, run: () => Promise<T>): Promise<T> {
  const mine: RefusalRun = {};
  const value = await runs.run(mine, run);
  if (mine.line) io.err(mine.line);
  return value;
}

/**
 * The one helper every refusal printer calls (ADR 0202 point 8): a command that refuses a build,
 * an upgrade or a write for one of BuildRefusalView's reasons, or because a newer Atticus
 * upgraded the metarepo. The standing line, worked out without the upgrade steps' dry runs, is
 * printed last on standard error by the command's scope, and set on the refusal as `standing`
 * (so `--json`, a job's result and the 409 problem carry it). Outside a scope (a function called
 * on its own) nothing is added. It never fails the refusal it follows.
 */
export async function refusalEnds(root: string, refused?: object): Promise<string | undefined> {
  const run = runs.getStore();
  if (!run) return undefined;
  try {
    run.line ??= (await standing(root, { quick: true })).line;
  } catch {
    return undefined;
  }
  if (refused) {
    (refused as { standing?: string }).standing = run.line;
    if ("reasons" in refused) run.build = refused as BuildRefusal;
  }
  return run.line;
}

/** The build's refusal this command printed, if any (`confirmOnce` asks about it). */
export const refusedBuild = (): BuildRefusal | undefined => runs.getStore()?.build;

/** The command goes on after a confirmed refusal: what follows is no refusal's end. */
export function refusalTakenBack(): void {
  const run = runs.getStore();
  if (run) {
    delete run.line;
    delete run.build;
  }
}
