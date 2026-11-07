import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
  isAdopted,
  loadOrgPack,
  orgPackDirOf,
  ReadingRulesFile,
  type OrgPack,
  type ReadingRule,
} from "@maycombhq/core";
import { estateRepos } from "@maycombhq/scanner";
import { globToRegExp } from "@maycombhq/sdk";
import { checkoutOf } from "./facts-files.js";
import { repoTypeOf } from "./org-notes.js";

/**
 * G4 (ADR 0176): the reading rules a read of a repo is given, from the org pack's layers in
 * order: imported (another team's, pinned), the organisation's, the repo's type's, the repo's.
 * A later layer adds; its `off` switches an earlier rule (or a built-in set, `builtin:<set>`) off
 * for its scope, saying why. Each rule has an id, `org:<key>@<hash>`, recorded with the read like
 * a built-in rule set (ADR 0167), so a changed rule tops up only the files it matches.
 */

export type Layer = "imported" | "org" | "type" | "repo";

export interface EffectiveRule extends ReadingRule {
  layer: Layer;
  /** The file it is written in, relative to the root. */
  file: string;
  /** `org:<key>@<8 hex>`: changes when the rule's words or files change. */
  id: string;
}

export interface EffectiveRules {
  rules: EffectiveRule[];
  drafts: EffectiveRule[];
  off: { key: string; reason: string; layer: Layer; file: string }[];
  problems: string[];
  /** The built-in rule sets a layer switched off. */
  builtinOff: string[];
}

export const rulesDirOf = (root: string) => join(orgPackDirOf(root), "reading-rules");
const relDir = (root: string) =>
  `${isAdopted(root) ? ".atticus/org-pack" : "org-pack"}/reading-rules`;

export const ruleId = (r: Pick<ReadingRule, "key" | "rule" | "files">) =>
  `org:${r.key}@${createHash("sha256")
    .update(JSON.stringify([r.rule, r.files ?? []]))
    .digest("hex")
    .slice(0, 8)}`;

async function readLayer(
  root: string,
  rel: string,
): Promise<{ file?: ReadingRulesFile; problem?: string }> {
  const text = await readFile(join(rulesDirOf(root), ...rel.split("/")), "utf8").catch(
    () => undefined,
  );
  if (text === undefined) return {};
  let data: unknown;
  try {
    data = parse(text);
  } catch (e) {
    return {
      problem: `${relDir(root)}/${rel} can't be read: ${(e as Error).message.split("\n")[0]}`,
    };
  }
  const r = ReadingRulesFile.safeParse(data);
  return r.success
    ? { file: r.data }
    : {
        problem: `${relDir(root)}/${rel} isn't valid: ${r.error.issues.map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`).join("; ")}`,
      };
}

/** The layers' files for a repo of a type, in order. */
async function layerFiles(root: string, repo: string, type?: string) {
  const out: { layer: Layer; rel: string }[] = [];
  if (type) {
    const teams = await readdir(join(rulesDirOf(root), "imported"), { withFileTypes: true }).catch(
      () => [],
    );
    for (const t of teams
      .filter((x) => x.isDirectory())
      .map((x) => x.name)
      .sort())
      out.push({ layer: "imported", rel: `imported/${t}/${type}.yaml` });
  }
  out.push({ layer: "org", rel: "org.yaml" });
  if (type) out.push({ layer: "type", rel: `types/${type}.yaml` });
  out.push({ layer: "repo", rel: `repos/${repo}.yaml` });
  return out;
}

/** The rules in force for a repo, its drafts, and what was switched off. */
export async function effectiveRules(
  root: string,
  repo: string,
  o: { dir?: string; op?: OrgPack } = {},
): Promise<EffectiveRules> {
  const op = o.op ?? (await loadOrgPack(orgPackDirOf(root)).catch(() => undefined));
  // The repo type the pack defines (by the manifest, else its fingerprint), else the manifest's
  // type as it is written: a team's rules for "fuse-service" need no repo type defined first.
  // Its checkout when none is given, so a read and a staleness check work out the same type.
  const dir = o.dir ?? (op ? await checkoutOf(root, repo).catch(() => undefined) : undefined);
  const type = op
    ? ((await repoTypeOf(op, repo, dir))?.id ?? estateRepos(op).find((r) => r.id === repo)?.type)
    : undefined;
  const byKey = new Map<string, EffectiveRule>();
  const drafts: EffectiveRule[] = [];
  const off: EffectiveRules["off"] = [];
  const problems: string[] = [];
  const builtinOff = new Set<string>();
  for (const { layer, rel } of await layerFiles(root, repo, type)) {
    const { file, problem } = await readLayer(root, rel);
    if (problem) problems.push(problem);
    if (!file) continue;
    const at = `${relDir(root)}/${rel}`;
    // An imported copy switches nothing off here: only this organisation's own layers do.
    for (const x of layer === "imported" ? [] : file.off) {
      off.push({ ...x, layer, file: at });
      if (x.key.startsWith("builtin:")) builtinOff.add(x.key.slice("builtin:".length));
      else byKey.delete(x.key);
    }
    for (const r of file.rules) {
      const e: EffectiveRule = { ...r, layer, file: at, id: ruleId(r) };
      if (r.status === "draft") drafts.push(e);
      else {
        const had = byKey.get(r.key);
        // Two teams' copies with one key: the later team's is used, and that is said.
        if (had && had.layer === "imported" && layer === "imported")
          problems.push(
            `${had.file} and ${at} both have an active rule ${r.key}: ${at}'s is given to reads. Rename one, or set one back to draft.`,
          );
        byKey.set(r.key, e);
      }
    }
  }
  return {
    rules: [...byKey.values()],
    drafts,
    off,
    problems,
    builtinOff: [...builtinOff].sort(),
  };
}

/** Whether a rule is about a file: its globs, or every file when it names none. */
export const ruleMatches = (r: Pick<ReadingRule, "files">, path: string) =>
  !r.files?.length || r.files.some((g) => globToRegExp(g).test(path));

/** The rules' ids, as a read records them beside the built-in rule sets. */
export const ruleIds = (e: EffectiveRules) => e.rules.map((r) => r.id).sort();

/** The rules in force that a read's record doesn't list (by id): what it wasn't given. */
export function orgRulesLacking(
  rec: { sets: readonly string[] } | undefined,
  e: EffectiveRules,
): EffectiveRule[] {
  const had = new Set(rec?.sets ?? []);
  return e.rules.filter((r) => !had.has(r.id));
}

/** The rules as a reader is given them: the organisation's own, after Atticus's. */
export function readingRulesText(
  e: Pick<EffectiveRules, "rules" | "builtinOff">,
  only?: ReadonlySet<string>,
): string {
  const rules = only ? e.rules.filter((r) => only.has(r.id)) : e.rules;
  if (!rules.length && !e.builtinOff.length) return "";
  return [
    "## The organisation's reading rules for this repo",
    "",
    "These come from the organisation's org pack, reviewed like code. Follow them as you follow the rules above; every fact still cites its line, and a rule never changes a fact's shape.",
    "",
    ...rules.map(
      (r) =>
        `- ${r.key} (${r.layer}${r.files?.length ? `; for ${r.files.join(", ")}` : ""}): ${r.rule.replace(/\s+/g, " ").trim()}${r.example ? ` For example ${r.example}.` : ""}`,
    ),
    ...(e.builtinOff.length
      ? [
          "",
          `Switched off here by the organisation: Atticus's ${e.builtinOff.join(", ")} rules; leave out what only they ask for.`,
        ]
      : []),
  ].join("\n");
}

/**
 * Everything a read lacks: the built-in rule sets added since it was read (ADR 0167) and the
 * organisation's rules it wasn't given (G4), by id.
 */
export async function rulesLackingAll(
  root: string,
  repo: string,
  rec: { hash: string; sets: readonly string[] } | undefined,
): Promise<string[]> {
  const { rulesLacking } = await import("@maycombhq/assistant-files");
  return [
    ...rulesLacking(rec),
    ...orgRulesLacking(
      rec,
      (await effectiveRules(root, repo).catch(() => undefined)) ?? {
        rules: [],
        drafts: [],
        off: [],
        problems: [],
        builtinOff: [],
      },
    )
      // A rule that names no files is given to the next whole read, never topped up alone.
      .filter((r) => r.files?.length)
      .map((r) => r.id),
  ];
}

/** The glob a cited file's kind of file is: `**\/*Client.java` for `.../PartnerClient.java`. */
export function kindGlob(file: string): string {
  const base = file.split("/").pop() ?? file;
  const m = /([A-Z][a-z0-9]+)\.([A-Za-z0-9]+)$/.exec(base);
  return m ? `**/*${m[1]}.${m[2]}` : `**/${base}`;
}

/**
 * G4 from the canvas (ADR 0176): a draft rule for every repo of a type, from a call a person
 * paired there: what the reads missed, said once for all of them, for a person to review and set
 * active. Its key names the box it went to.
 */
export function ruleFromPairing(o: {
  type: string;
  to: string;
  file: string;
  line: number;
  value: string;
  method?: string;
  path: string;
  by: string;
  /** Who asked for the draft (the app's user); `by` is who paired the call. */
  drafter?: string;
}): ReadingRule {
  const key = `paths-to-${o.to}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .slice(0, 60);
  return {
    key,
    status: "draft",
    rule: `In ${o.type} repos, a call to ${o.to} can name its path through a field, a setting or a helper (here \`${o.value}\`), not the path itself: follow it to the literal path the code or its settings give, and write that as the call's path, with the line that sets it in cite.with. The routes it reaches start like ${[o.method, o.path].filter(Boolean).join(" ")}.`,
    files: [kindGlob(o.file)],
    example: `${o.file}:${o.line}`,
    by: `drafted${o.drafter ? ` by ${o.drafter}` : ""} from ${o.by}'s pairing on the canvas`,
  };
}
