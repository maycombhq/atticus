import {
  addProfileSystem,
  factsDirOf,
  factsFileOf,
  loadOrgPack,
  orgPackDirOf,
  slugify,
  TARGETS_STEP_ID,
  topicOfQuestion,
  TOPICS_STEP_ID,
  type Question,
} from "@maycombhq/core";
import { readdir } from "node:fs/promises";
import { estateRepos, pickerLines, targetPicker, type TargetPick } from "@maycombhq/scanner";

/**
 * "Another repo…" (ADR 0162, F8): a targets answer that names any repo of the manifest, any system
 * of the profiles or a team in roles.yaml. A vendor not in the profile, or a team with no system
 * yet, is offered as a new system, written into the profile only when the person says so
 * (`addSystem`): a file change in the metarepo, for review in the pull request, never a write to a
 * shared system. Shared by `atticus questions answer --target` and the app's Questions page.
 */

export type AddSystem = "vendor" | "internal";

export interface TargetSystem {
  id: string;
  profile: string;
  added: boolean;
  boundary: AddSystem;
  owner?: string;
  /** A topics answer: the topic written into the system's aliases. */
  aliased?: string[];
}

export type TargetAnswer =
  | {
      /** The words the answer records: a repo's or system's id. */
      text: string;
      pick: TargetPick | undefined;
      /**
       * The profile change the answer brings, when it brings one: made by the caller only once
       * the answer is accepted (`answerQuestion`'s `beforeWrite`, review item 14), so a refused
       * answer leaves the profile as it was. It throws when the profile would not be valid.
       */
      write?: () => Promise<TargetSystem>;
    }
  | {
      problem: string;
      /** What would add it: the system and the flag to pass. */
      offer?: { id: string; name: string; boundary: AddSystem; owner?: string; flag: string };
    };

/**
 * The repos whose facts are on file (facts/<repo>.jsonl). By `factsFileOf`, so a dotted repo id
 * (`forge-ledger.v2`) counts and a companion file (`<repo>.reviewed.jsonl`) doesn't.
 */
async function readRepos(root: string): Promise<Set<string>> {
  const names = await readdir(factsDirOf(root)).catch(() => [] as string[]);
  const out = new Set<string>();
  for (const n of names) {
    const of = factsFileOf(n);
    if (of?.facts) out.add(of.repo);
  }
  return out;
}

/** The picker of the whole estate for a root: repos (read or not), systems and teams. */
export async function pickerOf(root: string): Promise<TargetPick[]> {
  const op = await loadOrgPack(orgPackDirOf(root));
  return targetPicker(op, await readRepos(root));
}

/** The picker in lines, for the terminal. */
export const pickerText = (picks: readonly TargetPick[]) => pickerLines(picks);

/** Read a `--target` against the picker, adding the system it offers when `addSystem` says so. */
export async function targetAnswerOf(
  root: string,
  q: Question,
  target: string,
  o: { addSystem?: AddSystem; name?: string } = {},
): Promise<TargetAnswer> {
  const topic = q.askedBy.step === TOPICS_STEP_ID ? topicOfQuestion(q) : undefined;
  if (q.askedBy.step !== TARGETS_STEP_ID && !topic)
    return {
      problem: `${q.id} doesn't ask where a call goes or who owns a topic, so it takes no --target: answer it with --option <n> or --text.`,
    };
  const op = await loadOrgPack(orgPackDirOf(root));
  const picks = targetPicker(op, await readRepos(root));
  const want = target.trim().toLowerCase();
  // A repo's component names the repo too.
  const byComponent = estateRepos(op).find((r) => r.component?.toLowerCase() === want);
  const pick =
    picks.find((p) => p.id.toLowerCase() === want) ??
    (byComponent ? picks.find((p) => p.kind === "repo" && p.id === byComponent.id) : undefined);
  const add = (s: { id: string; name: string; boundary: AddSystem; owner?: string }) => ({
    text: s.id,
    pick,
    write: async (): Promise<TargetSystem> => {
      // A topics answer puts the topic among the system's aliases (ADR 0162).
      const r = await addProfileSystem(root, q.repo, {
        ...s,
        ...(topic ? { aliases: [topic] } : {}),
      });
      return { ...r, boundary: s.boundary, ...(s.owner ? { owner: s.owner } : {}) };
    },
  });
  if (pick?.kind === "repo" && topic)
    return {
      problem: `${pick.id} is a repo of the estate: its own facts say what it publishes and listens on. Read it (/atticus-map ${pick.id}, then atticus verify ${pick.id} --write) and ${topic} joins it; answer "None of these" until then.`,
    };
  if (pick?.kind === "repo") return { text: byComponent?.component ?? pick.id, pick };
  const systemOf = (id: string) =>
    op.profiles.flatMap((p) => p.profile?.systems ?? []).find((s) => s.id === id)!;
  if (pick?.kind === "system" && topic) {
    const s = systemOf(pick.id);
    return add({
      id: s.id,
      name: s.name,
      boundary: s.boundary === "vendor" ? "vendor" : "internal",
      ...(s.owner ? { owner: s.owner } : {}),
    });
  }
  if (pick?.kind === "system") return { text: pick.id, pick };
  if (pick?.kind === "team") {
    const theirs = op.profiles
      .flatMap((p) => p.profile?.systems ?? [])
      .filter((s) => s.owner === pick.id)
      .map((s) => s.id)
      .sort();
    if (theirs.length && topic) {
      const s = systemOf(theirs[0]!);
      return add({
        id: s.id,
        name: s.name,
        boundary: s.boundary === "vendor" ? "vendor" : "internal",
        owner: pick.id,
      });
    }
    if (theirs.length) return { text: theirs[0]!, pick };
    const adds = pick.adds!;
    if (o.addSystem) return add({ ...adds, ...(o.name ? { name: o.name } : {}) });
    return {
      problem: `${pick.id} has no system in the profile yet.`,
      offer: { ...adds, flag: "--add-system internal" },
    };
  }
  const id = slugify(target);
  if (!id) return { problem: `"${target}" names nothing: give a repo, system or team id.` };
  if (o.addSystem) return add({ id, name: o.name?.trim() || target.trim(), boundary: o.addSystem });
  return {
    problem: `${target} isn't a repo of the manifest, a system of the profile or a team in roles.yaml.`,
    offer: { id, name: target.trim(), boundary: "vendor", flag: "--add-system vendor" },
  };
}

/** The offer of a new system, in a person's words, with the command that takes it. */
export function offerLine(
  qid: string,
  target: string,
  offer: { id: string; name: string; boundary: AddSystem; owner?: string; flag: string },
): string {
  const what =
    offer.boundary === "vendor"
      ? `a vendor, ${offer.name} (id ${offer.id})`
      : `another team's system, ${offer.name} (id ${offer.id}${offer.owner ? `, owner ${offer.owner}` : ""})`;
  return `To add it as ${what} in the profile, written as a file change for review in the pull request: atticus questions answer ${qid} --target ${target} ${offer.flag}${offer.boundary === "vendor" ? ' (--name "..." to name it; --add-system internal if it is another team\'s)' : ' (--name "..." to name it)'}.`;
}
