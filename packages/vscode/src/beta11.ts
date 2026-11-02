import type { Cli, OpenQuestion } from "./types";

/**
 * What beta.11 added to the command line and the app, caught up in the extension (ADR 0166): the
 * "Another repo…" picker of a target or topics question (ADR 0162), the contract check's count
 * (ADR 0164), and the words a repo type's notes add (ADR 0163). No `vscode` here, so it is tested
 * outside the editor; extension.ts and jobs-ui.ts ask and run.
 */

/**
 * The options that open the picker of the whole estate rather than answer (core's PICKER_LABELS):
 * a targets question's "Another repo…" and a topics question's "A topic owned by another team or
 * vendor". They name nothing, so the command line refuses them as an answer.
 */
export const PICKER_LABELS: ReadonlySet<string> = new Set([
  "Another repo…",
  "A topic owned by another team or vendor",
]);

/** Whether the option picked (counting from 1) opens the picker instead of answering. */
export const opensPicker = (q: Pick<OpenQuestion, "options">, option: number): boolean =>
  PICKER_LABELS.has(q.options[option - 1]?.label ?? "");

/** One entry of the picker, as `atticus questions show <id> --json` gives it under `picks`. */
export interface TargetPick {
  id: string;
  kind: "repo" | "system" | "team";
  name: string;
  read?: boolean;
  boundary?: string;
  /** A team with no system yet: the system naming it adds to the profile (with --add-system). */
  adds?: { id: string; name: string; boundary: "internal"; owner: string };
}

/** The picker of a question: every repo of the manifest, every profile system, every team. */
export async function readPicks(
  cli: Cli,
  root: string,
  id: string,
): Promise<{ ok: true; picks: TargetPick[] } | { ok: false; message: string }> {
  const r = await cli(["questions", "show", id, "--json", "--root", root]);
  if (r.code !== 0)
    return { ok: false, message: (r.stderr || r.stdout).trim().split("\n")[0] ?? "" };
  try {
    const shown = JSON.parse(r.stdout) as { picks?: TargetPick[] };
    if (!Array.isArray(shown.picks))
      return {
        ok: false,
        message:
          "This atticus gives no list of repos, systems and teams for the question (it needs 2.0.0-beta.11): answer it in your own words, or atticus questions answer <id> --target <id>.",
      };
    return { ok: true, picks: shown.picks };
  } catch {
    return {
      ok: false,
      message: "atticus questions show --json printed something that isn't JSON.",
    };
  }
}

/** A row of the picker in a quick pick: its kind and whether it is read beside its name. */
export interface PickRow {
  label: string;
  description: string;
  detail?: string;
  /** The id `--target` takes; empty for the row that types a name not listed. */
  target: string;
  pick?: TargetPick;
}

const KIND_WORDS = { repo: "Repos", system: "Systems in the profile", team: "Teams" } as const;

/** The picker as rows, grouped repos, systems, teams (each group's name is a separator's label). */
export function pickRows(picks: readonly TargetPick[]): (PickRow | { separator: string })[] {
  const out: (PickRow | { separator: string })[] = [];
  for (const kind of ["repo", "system", "team"] as const) {
    const of = picks.filter((p) => p.kind === kind);
    if (!of.length) continue;
    out.push({ separator: KIND_WORDS[kind] });
    for (const p of of)
      out.push({
        label:
          p.name && p.name !== p.id && kind !== "repo" ? `${p.name} (${p.id})` : p.name || p.id,
        description:
          kind === "repo"
            ? p.read
              ? "read"
              : "not read yet"
            : kind === "system"
              ? (p.boundary ?? "")
              : p.adds
                ? "no system yet: adds one to the profile, after your yes"
                : "its system",
        target: p.id,
        pick: p,
      });
  }
  out.push({ separator: "" });
  out.push({
    label: TYPE_ANOTHER,
    description: "a vendor or another team's system the profile doesn't have yet",
    target: "",
  });
  return out;
}

/** The last row: a name the list doesn't have, offered as a new system after the person's yes. */
export const TYPE_ANOTHER = "Not listed: type its name…";

/** What naming a target brings: an answer as it stands, or a system to add first, asked. */
export type TargetPlan =
  | { target: string }
  | {
      target: string;
      /** Asked before anything is written: the new system and where it goes. */
      offer: { id: string; name: string; boundary: "vendor" | "internal"; owner?: string };
    };

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * The plan for a target named from the picker or typed: a repo, a system or a team with a
 * system answers as it is; a team with no system, or a name the picker doesn't have, is a new
 * system offered for the profile (`--add-system`), written only after the person says yes. The
 * command line decides again: it is the one that writes.
 */
export function targetPlan(picks: readonly TargetPick[], typed: string): TargetPlan | undefined {
  const t = typed.trim();
  if (!t) return undefined;
  const p = picks.find((x) => x.id.toLowerCase() === t.toLowerCase());
  if (p?.kind === "team" && p.adds)
    return {
      target: p.id,
      offer: {
        id: p.adds.id,
        name: p.adds.name,
        boundary: "internal",
        owner: p.adds.owner,
      },
    };
  if (p) return { target: p.id };
  const id = slug(t);
  if (!id) return undefined;
  return { target: t, offer: { id, name: t, boundary: "vendor" } };
}

/** The question asked before a new system is written into the profile. */
export function offerWords(o: {
  id: string;
  name: string;
  boundary: "vendor" | "internal";
  owner?: string;
}): string {
  return o.boundary === "vendor"
    ? `${o.name} isn't a repo of the manifest, a system of the profile or a team in roles.yaml. Add it to the profile as a new system (id ${o.id}), for review in the pull request?`
    : `${o.owner ?? o.name} has no system in the profile yet. Add ${o.name} (id ${o.id}, owner ${o.owner ?? ""}) to the profile as another team's system, for review in the pull request?`;
}

/** The buttons of the offer: what each adds it as. */
export const OFFER_VENDOR = "Add it as a vendor";
export const OFFER_INTERNAL = "Add it as another team's system";

/** `questions answer <id> --target <t> [--add-system vendor|internal] [--name "..."]`'s words. */
export function targetArgs(t: {
  target: string;
  addSystem?: "vendor" | "internal";
  name?: string;
}): string[] {
  return [
    "--target",
    t.target,
    ...(t.addSystem ? ["--add-system", t.addSystem] : []),
    ...(t.name ? ["--name", t.name] : []),
  ];
}

// ------------------------------------------------------------------ the contract check (F7)

/** The contract check's counts over the estate (`atticus join contracts --json`'s `counts`). */
export interface ContractCounts {
  links: number;
  compared: number;
  mismatches: number;
  unconfirmed: number;
}

/** The counts, read with `atticus join contracts --json`; undefined when it can't say. */
export async function readContractCounts(
  cli: Cli,
  root: string,
): Promise<ContractCounts | undefined> {
  try {
    const r = await cli(["join", "contracts", "--json", "--root", root]);
    if (r.code !== 0) return undefined;
    const c = (JSON.parse(r.stdout) as { counts?: Partial<ContractCounts> }).counts;
    if (!c || typeof c.mismatches !== "number") return undefined;
    return {
      links: c.links ?? 0,
      compared: c.compared ?? 0,
      mismatches: c.mismatches,
      unconfirmed: c.unconfirmed ?? 0,
    };
  } catch {
    return undefined;
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The status bar's part: said only when the check found a mismatch. */
export function contractsStatus(c: ContractCounts | undefined): string | undefined {
  return c && c.mismatches > 0
    ? plural(c.mismatches, "contract mismatch", "contract mismatches")
    : undefined;
}

/** The status bar tooltip's line, and the job's title line: the counts in words. */
export function contractsWords(c: ContractCounts | undefined): string | undefined {
  if (!c) return undefined;
  if (!c.compared) return "Contract check: no link has a payload on both sides to compare yet.";
  return `Contract check: ${plural(c.mismatches, "mismatch", "mismatches")}, ${c.unconfirmed} unconfirmed, on ${plural(c.compared, "link")} compared (Map › Mismatches).`;
}

// ------------------------------------------------------------------ repo types' notes (F9)

/** A repo type's notes, or the org-wide ones (conventions.yaml). */
export const ORG_WIDE = "";

/** `repo-type note <type> | --org-wide`, and `--add "..."` when a note is given. */
export function noteArgs(type: string, note?: string): string[] {
  return [
    "repo-type",
    "note",
    ...(type === ORG_WIDE ? ["--org-wide"] : [type]),
    ...(note !== undefined ? ["--add", note] : []),
  ];
}

/** A note as the command line takes it: one line, 1 to 1000 characters. */
export function noteOf(typed: string): string | undefined {
  const n = typed.replace(/\s*[\r\n]+\s*/g, " ").trim();
  return n && n.length <= 1000 ? n : undefined;
}

/** The repo types of an org pack: the folders of org-pack/repo-types with a type.yaml. */
export function repoTypesIn(
  names: readonly string[],
  hasTypeFile: (name: string) => boolean,
): string[] {
  return names.filter((n) => !n.startsWith(".") && hasTypeFile(n)).sort();
}
