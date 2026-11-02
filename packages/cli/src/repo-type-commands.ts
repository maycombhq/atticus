import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Document, isScalar, parse, parseDocument, visit } from "yaml";
import {
  ChecklistPack,
  Conventions,
  CONVENTIONS_SCHEMA_VERSION,
  loadOrgPack,
  noteRuleDrafts,
  noteKey,
  notesFor,
  OrgNote,
  orgPackDirOf,
  RecordId,
  REPO_TYPE_SCHEMA_VERSION,
  RepoType,
  REVIEW_SCHEMA_VERSION,
  RULE_WORDS,
  TERM_STEP,
  termAnswerNote,
  termOfQuestion,
  type Question,
} from "@maycombhq/core";
import { draftRepoType, matchRepoType, type RepoTypeMatches } from "@maycombhq/scanner";
import { fsRepo } from "@maycombhq/sdk";
import type { Output } from "./commands.js";
import { repoFor } from "./onboard-commands.js";

/**
 * atticus repo-type (ADR 0077): match a repo against the org pack's repo types by fingerprint,
 * and draft a new type from a repo. Both deterministic; no AI.
 */

const pct = (n: number) => `${Math.round(n * 100)}%`;
const notFound = (target: string) =>
  `${target} isn't a cloned repo of the manifest or a folder; clone it with atticus workspace sync, or give its folder.`;

function verdictLine(id: string, r: RepoTypeMatches): string {
  const best = r.matches.find((m) => m.type === r.best);
  switch (r.verdict) {
    case "clear":
      return `${id} is a clear match for ${best!.name} (${best!.type}), ${pct(best!.score)}. Reuse it: atticus scan survey ${id} hands its settings and skills to your assistant.`;
    case "partial":
      return `${id} is a partial match for ${best!.name} (${best!.type}), ${pct(best!.score)}. Reuse it, and extend the type with what this repo does differently.`;
    case "tie":
      return `${id} matches ${r.tied!.join(" and ")} about as well.${r.fromDescription ? ` Its description says "${r.fromDescription.words}", so ${r.fromDescription.type} is the likelier of them; a person still decides.` : ""} A person decides which it is; then change the types so their fingerprints tell them apart.`;
    case "none":
      return `${id} matches no known repo type.${r.fromDescription ? ` Its description says "${r.fromDescription.words}", so ${r.fromDescription.type} may be it, though nothing in its files says so.` : ""} Draft one: atticus repo-type new <id> --from ${id}`;
  }
}

/** The type as YAML a person can read: short lists on one line, long text unfolded. */
function typeYaml(t: object): string {
  const doc = new Document(t);
  visit(doc, {
    Seq(_, node) {
      if (node.items.every((i) => isScalar(i))) node.flow = true;
    },
  });
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

/** atticus repo-type detect <repo> [--json]: the ranked matches, with the evidence for each. */
export async function repoTypeDetect(
  root: string,
  target: string,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  const repo = await repoFor(root, target);
  if (!repo) {
    io.err(notFound(target));
    return 2;
  }
  const op = await loadOrgPack(orgPackDirOf(root));
  // What a person says the repo is (ADR 0128): read only to lean a tie or suggest where the
  // fingerprints found nothing, never to overrule what the files say.
  const said = op.profiles.flatMap((p) => p.repos?.repos ?? []).find((x) => x.id === repo.id)
    ?.description?.text;
  const r = await matchRepoType(fsRepo(repo.id, repo.dir, "0".repeat(40)), op.repoTypes, {
    ...(said ? { description: said } : {}),
  });
  if (o.json) {
    io.out(JSON.stringify({ repo: repo.id, ...r }, null, 2));
    return 0;
  }
  if (op.repoTypes.length === 0) {
    io.out(
      `The org pack has no repo types yet (org-pack/repo-types/<id>/type.yaml). Draft one: atticus repo-type new <id> --from ${repo.id}`,
    );
    return 0;
  }
  io.out(verdictLine(repo.id, r));
  for (const m of r.matches) {
    io.out(
      `  ${m.type}  ${pct(m.score)} (${m.got} of ${m.total})${m.ruledOut ? ", ruled out: a required signal is missing" : ""}`,
    );
    for (const s of m.signals)
      io.out(
        `    ${s.found ? "found  " : "missing"}  ${s.label} (${s.weight}${s.required ? ", required" : ""})${s.found ? `: ${s.evidence.join(", ")}` : ""}`,
      );
  }
  return 0;
}

/** atticus repo-type new <id> --from <repo> [--force]: draft a type from a repo, to edit. */
export async function repoTypeNew(
  root: string,
  id: string,
  o: { from?: string; force?: boolean; now?: Date },
  io: Output,
): Promise<number> {
  if (!RecordId.safeParse(id).success || !o.from) {
    io.err(
      "Usage: atticus repo-type new <id> --from <repo> [--force]. The id is a lowercase slug, like forge-spring-service.",
    );
    return 2;
  }
  const repo = await repoFor(root, o.from);
  if (!repo) {
    io.err(notFound(o.from));
    return 2;
  }
  const dir = join(orgPackDirOf(root), "repo-types", id);
  const file = join(dir, "type.yaml");
  if (!o.force && (await stat(file).catch(() => undefined))) {
    io.err(
      `The repo type ${id} already exists (org-pack/repo-types/${id}/type.yaml). Re-run with --force to draft it again.`,
    );
    return 1;
  }
  const t = await draftRepoType(fsRepo(repo.id, repo.dir, "0".repeat(40)), id);
  if (!t) {
    io.out(
      `${repo.id} has no build file, dependency, framework marker or known folder to fingerprint; nothing was written. Write the type by hand.`,
    );
    return 1;
  }
  await mkdir(dir, { recursive: true });
  const date = (o.now ?? new Date()).toISOString().slice(0, 10);
  await writeFile(
    file,
    `# Drafted from ${repo.id} by atticus repo-type new on ${date} (ADR 0077). Edit it: name what kind\n# of repo this is, keep the signals every repo of the kind has, set the weights, add skills.\n${typeYaml(t)}`,
    "utf8",
  );
  const kinds = new Map<string, number>();
  for (const s of t.fingerprint) kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
  io.out(
    `Wrote org-pack/repo-types/${id}/type.yaml from ${repo.id}: ${[...kinds].map(([k, n]) => `${n} ${k}`).join(", ")} ${t.fingerprint.length === 1 ? "signal" : "signals"}, ${t.settings.prefixes.length} prefix ${t.settings.prefixes.length === 1 ? "rule" : "rules"}.`,
  );
  io.out(
    `Next: edit it, check it with atticus repo-type detect ${repo.id} and atticus orgpack validate, then review it in a pull request.`,
  );
  return 0;
}

// ---------------------------------------------------------------- notes (ADR 0163)

const noteFileOf = (root: string, type: string | undefined) =>
  type
    ? join(orgPackDirOf(root), "repo-types", type, "type.yaml")
    : join(orgPackDirOf(root), "conventions.yaml");
const noteRel = (type: string | undefined) =>
  type ? `org-pack/repo-types/${type}/type.yaml` : "org-pack/conventions.yaml";

/**
 * atticus repo-type note <type> [--add "..."] | --org-wide [--add "..."]: list a repo type's notes
 * (or the org-wide ones), or add one, in the organisation's own words. The file is a version-2
 * file after an add; the rest of it is kept as written. Plain text: Atticus never parses a note.
 */
export async function repoTypeNote(
  root: string,
  type: string | undefined,
  o: { add?: string; org?: boolean },
  io: Output,
): Promise<number> {
  if ((!type && !o.org) || (type && o.org)) {
    io.err(
      'Usage: atticus repo-type note <type> [--add "..."], or atticus repo-type note --org-wide [--add "..."] for the notes every repo is read with.',
    );
    return 2;
  }
  const file = noteFileOf(root, type);
  const exists = await stat(file).catch(() => undefined);
  if (type && !exists) {
    io.err(
      `No repo type ${type} (${noteRel(type)}). Draft one: atticus repo-type new ${type} --from <repo>`,
    );
    return 2;
  }
  const doc = exists
    ? parseDocument(await readFile(file, "utf8"))
    : new Document({ schemaVersion: CONVENTIONS_SCHEMA_VERSION });
  const notes = ((doc.toJS() as { notes?: unknown } | null)?.notes ?? []) as unknown[];
  if (o.add === undefined) {
    if (!notes.length)
      io.out(
        `${noteRel(type)} has no notes yet. Add one: atticus repo-type note ${type ?? "--org-wide"} --add "..."`,
      );
    // the number as the read lists it, and the key a term fact and a rule draft name it by
    notes.forEach((n, i) => io.out(`${i + 1}. ${String(n)} (note ${noteKey(String(n))})`));
    return 0;
  }
  // A note is one line (review 6): line breaks in what was given become spaces.
  const note = OrgNote.safeParse(o.add.replace(/\s*[\r\n]+\s*/g, " "));
  if (!note.success) {
    io.err("A note is plain text, from 1 to 1000 characters, on one line.");
    return 2;
  }
  if (notes.some((n) => String(n).trim() === note.data)) {
    io.out(`${noteRel(type)} already has that note.`);
    return 0;
  }
  doc.set("schemaVersion", type ? REPO_TYPE_SCHEMA_VERSION : CONVENTIONS_SCHEMA_VERSION);
  doc.set("notes", [...notes.map(String), note.data]);
  const check = (type ? RepoType : Conventions).safeParse(doc.toJS());
  if (!check.success) {
    io.err(
      `${noteRel(type)} doesn't read as it should with the note added: ${check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
    return 1;
  }
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, doc.toString({ lineWidth: 0 }), "utf8");
  io.out(
    `Added note ${notes.length + 1} (note ${noteKey(note.data)}) to ${noteRel(type)}. The next read of ${type ? `each ${type} repo` : "every repo"} is handed it; review it in a pull request.`,
  );
  if (RULE_WORDS.test(note.data))
    io.out(
      `It reads as a rule: atticus repo-type rules drafts a checklist rule from it for a person to review.`,
    );
  return 0;
}

/**
 * The note an answered term question offers to save (ADR 0163), as the command that saves it;
 * undefined for any other question.
 */
export function termNoteOffer(q: Question): string | undefined {
  if (q.askedBy.step !== TERM_STEP || !q.answer) return undefined;
  const about = termOfQuestion(q.question);
  if (!about) return undefined;
  const label = q.answer.option ? q.options[q.answer.option - 1]?.label : undefined;
  const text = termAnswerNote({
    ...about,
    ...(q.answer.text ? { text: q.answer.text } : {}),
    ...(label === "owner" || label === "consumer" || label === "none" ? { option: label } : {}),
  });
  const type = q.scope.level === "repo-type" ? q.scope.id : undefined;
  return type
    ? `Save it as a note on ${type}, so every ${type} repo is read with it: atticus repo-type note ${type} --add ${JSON.stringify(text)}`
    : `Save it as a note every repo is read with: atticus repo-type note --org-wide --add ${JSON.stringify(text)}`;
}

/** The checklist file the rule drafts from notes go in. */
export const NOTE_RULES_FILE = "checklists/org-notes.yaml";

/**
 * atticus repo-type rules [--save]: a checklist rule draft (C3, status draft) for each note that
 * reads as a rule (all, every, must), on every repo type and org-wide. --save adds the drafts
 * not yet there to org-pack/checklists/org-notes.yaml, keeping every rule already in it as a
 * person left it. An accepted rule (status active) is checked at each atticus verify <repo> --write.
 */
export async function repoTypeRules(
  root: string,
  o: { write?: boolean; json?: boolean },
  io: Output,
): Promise<number> {
  const op = await loadOrgPack(orgPackDirOf(root));
  const notes = [
    ...op.repoTypes.flatMap((t) => notesFor(t, undefined)),
    ...notesFor(undefined, op.conventions),
  ];
  const drafts = noteRuleDrafts(notes);
  const file = join(orgPackDirOf(root), ...NOTE_RULES_FILE.split("/"));
  const onFile = (await stat(file).catch(() => undefined))
    ? ChecklistPack.safeParse(parse(await readFile(file, "utf8")))
    : undefined;
  if (onFile && !onFile.success) {
    io.err(
      `org-pack/${NOTE_RULES_FILE} doesn't read as a checklist; fix it first (atticus orgpack validate).`,
    );
    return 1;
  }
  const kept = onFile?.data.rules ?? [];
  const fresh = drafts.filter((d) => !kept.some((k) => k.id === d.id));
  if (o.json) {
    io.out(
      JSON.stringify(
        { file: `org-pack/${NOTE_RULES_FILE}`, drafts, fresh: fresh.map((d) => d.id) },
        null,
        2,
      ),
    );
  } else if (!drafts.length) {
    io.out(
      'No note reads as a rule (all, every or must). Notes are added with atticus repo-type note <type> --add "...".',
    );
    return 0;
  } else
    for (const d of drafts)
      io.out(
        `${d.id}${kept.some((k) => k.id === d.id) ? ` (in org-pack/${NOTE_RULES_FILE}, ${kept.find((k) => k.id === d.id)!.status})` : " (new draft)"}: ${d.title}\n  check: ${d.check.type === "deterministic" ? `${d.check.check} ${JSON.stringify(d.check.params)}` : "ai"}; from ${d.source}`,
      );
  if (!o.write) {
    if (!o.json && fresh.length)
      io.out(
        `Write the new drafts with atticus repo-type rules --save, then review them in a pull request.`,
      );
    return 0;
  }
  if (!fresh.length) {
    if (!o.json) io.out(`org-pack/${NOTE_RULES_FILE} already has every draft.`);
    return 0;
  }
  const pack = ChecklistPack.parse({
    schemaVersion: REVIEW_SCHEMA_VERSION,
    name: onFile?.data.name ?? "org-notes",
    version: onFile?.data.version ?? "0.1.0",
    description:
      onFile?.data.description ??
      "Rules drafted from the organisation's notes (ADR 0163). A person sets what each checks and makes it active; Atticus never reads the note to check it.",
    rules: [...kept, ...fresh],
  });
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(
    file,
    `# Drafted by atticus repo-type rules from the org pack's notes (ADR 0163). Review each rule:\n# set its check, then change status from draft to active. Accepted call-security rules are\n# checked at each atticus verify <repo> --write.\n${typeYaml(pack)}`,
    "utf8",
  );
  if (!o.json)
    io.out(
      `Wrote ${fresh.length} ${fresh.length === 1 ? "draft" : "drafts"} to org-pack/${NOTE_RULES_FILE}; review them in a pull request.`,
    );
  return 0;
}
