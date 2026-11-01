import { conventionsOf, loadOrgPack, orgPackDirOf, type OrgPack } from "@maycombhq/core";
import { globToRegExp } from "@maycombhq/sdk";
import {
  dirSource,
  houseImportsUntaught,
  readRulesOf,
  type FileSource,
  type HouseImport,
} from "@maycombhq/verify";
import { excludesOf } from "./facts-files.js";

/**
 * R3 (ADR 0147): before a repo's first read, the house packages it imports that no framework
 * taught to Atticus covers. None unless the org pack's conventions.yaml names house prefixes.
 */
export async function houseUntaughtOf(
  root: string,
  repo: string,
  o: { dir: string; source?: FileSource; op?: OrgPack; exclude?: readonly string[] },
): Promise<HouseImport[]> {
  const op = o.op ?? (await loadOrgPack(orgPackDirOf(root)).catch(() => undefined));
  const conventions = conventionsOf(op);
  if (!conventions.housePrefixes.length) return [];
  const exclude = o.exclude ?? (await excludesOf(root, repo));
  return houseImportsUntaught(o.source ?? dirSource(o.dir), {
    prefixes: conventions.housePrefixes,
    taught: (op?.frameworks ?? []).flatMap((m) => m.packages),
    rules: readRulesOf(conventions),
    exclude: exclude.map(globToRegExp),
  });
}

/** The warning, as `atticus map --estimate` prints it. Empty when there is nothing to teach. */
export function houseUntaughtLines(repo: string, found: readonly HouseImport[]): string[] {
  if (!found.length) return [];
  const one = found.length === 1;
  return [
    `Teach first: ${repo} imports ${one ? "a house package" : `${found.length} house packages`} no framework taught to Atticus covers (the org pack's housePrefixes). Read without ${one ? "it" : "them"}, ${one ? "its" : "their"} annotations and wrapper calls are ordinary code to the reader; teach ${one ? "it" : "each"} before the first read, then run this again:`,
    ...found.map(
      (h) =>
        `  - ${h.package} (${h.files} ${h.files === 1 ? "file" : "files"}, first at ${h.first}): ${h.command}`,
    ),
  ];
}

/** The same in one sentence, for `atticus next`'s map step. */
export function houseUntaughtWords(repo: string, found: readonly HouseImport[]): string {
  if (!found.length) return "";
  const shown = found.slice(0, 3).map((h) => h.package);
  const more = found.length > shown.length ? ` and ${found.length - shown.length} more` : "";
  return ` Teach first: ${repo} imports ${shown.join(", ")}${more}, ${found.length === 1 ? "a house package" : "house packages"} no taught framework covers; run ${found[0]!.command}${found.length > 1 ? " (one per package; atticus map " + repo + " --estimate lists them)" : ""} before reading it.`;
}
