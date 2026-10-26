import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  addManifestRepo,
  descriptionLine,
  ManifestEditError,
  manifestFiles,
  RecordId,
  REPO_DESCRIPTION_MAX,
  RepoDescription,
  setManifestDescription,
  type RepoDescriptionCite,
} from "@maycombhq/core";
import { gitUser, loadRepos } from "@maycombhq/workspace";
import type { Output } from "./commands.js";

/**
 * `atticus repo add` and `atticus repo describe` (ADR 0128): a repo into the manifest with what
 * it is in a person's own words, and that description set, edited, confirmed or rejected later
 * for a repo that has none. A repo id at a bank often says nothing, so the one line a person
 * writes here is what the reading prompts, the proposals, the questions and the views show.
 *
 * Nothing blocks on typing: `--description` gives it outright, a terminal is asked once, and a
 * run with no terminal (a script, a bulk add) says which repos still need one. The repos with
 * none are listed by `atticus repo describe` and by `atticus next`.
 */

/** Asked for a description; undefined when nothing can ask (no terminal) or nothing is typed. */
export type AskText = (prompt: string) => Promise<string | undefined>;

export interface RepoDeps {
  ask?: AskText;
  now?: Date;
  /** The person, when the Git user shouldn't be read. */
  by?: string;
}

/** Ask on the terminal, once, and take an empty answer as "not now". */
export const askOnTerminal: AskText = async (prompt) => {
  if (!stdin.isTTY) return undefined;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(`${prompt} `)).trim() || undefined;
  } finally {
    rl.close();
  }
};

const ASK =
  "What is this repo, in one line? (what it is for, who uses it; Enter to skip and write it later)";

/** The id a URL suggests: its last path segment without .git, as a slug. */
export function idFromUrl(url: string): string {
  const last =
    url
      .replace(/[/\\]+$/, "")
      .split(/[/\\:]/)
      .pop() ?? "";
  return (
    last
      .replace(/\.git$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "repo"
  );
}

const trimmed = (t: string | undefined) => {
  const s = t?.trim();
  return s ? s.slice(0, REPO_DESCRIPTION_MAX) : undefined;
};

/** A person's own words, with who wrote them and when. */
function written(text: string, by: string, now: Date): RepoDescription {
  return RepoDescription.parse({
    text,
    trust: "verified",
    by,
    at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
}

/**
 * The repo's type, when `--type` isn't given and the URL is a folder on this machine: read from
 * its own files, and only where they say nothing, from what the person wrote about it (ADR 0128).
 * Nothing for a URL there is no clone of yet; the type is then `unknown`, which is a question.
 */
async function typeOf(
  url: string,
  description: string | undefined,
): Promise<{ type: string; signals: string[]; confidence: string } | undefined> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[^/\\]+@/.test(url)) return undefined;
  const dir = resolve(url);
  if (
    !(await stat(dir).then(
      (s) => s.isDirectory(),
      () => false,
    ))
  )
    return undefined;
  const [{ detectRepoType }, { fsRepo }] = await Promise.all([
    import("@maycombhq/adopt"),
    import("@maycombhq/sdk"),
  ]);
  const d = await detectRepoType(fsRepo(basename(dir), dir, "0".repeat(40)), {
    ...(description ? { description } : {}),
  });
  return d.type === "unknown"
    ? undefined
    : { type: d.type, signals: d.signals, confidence: d.confidence };
}

async function whoFor(root: string, d: RepoDeps): Promise<string> {
  if (d.by) return d.by;
  try {
    return (await gitUser(root)).handle;
  } catch {
    return "someone";
  }
}

/**
 * atticus repo add <url> [--id id] [--type t] [--owner team] [--system s] [--component c]
 *   [--platform p] [--description "..."] [--no-description] [--json]
 */
export async function repoAdd(
  root: string,
  url: string | undefined,
  o: {
    id?: string;
    type?: string;
    owner?: string;
    system?: string;
    component?: string;
    platform?: string;
    description?: string;
    noDescription?: boolean;
    json?: boolean;
  },
  io: Output,
  deps: RepoDeps = {},
): Promise<number> {
  if (!url?.trim()) {
    io.err(
      'Usage: atticus repo add <clone URL or path> [--id id] [--type repo type] [--owner team] [--description "what it is"].',
    );
    return 2;
  }
  const id = o.id?.trim() || idFromUrl(url.trim());
  if (!RecordId.safeParse(id).success) {
    io.err(
      `${id} isn't a repo id: ids are lowercase slugs (a-z, 0-9, '.', '_' and '-'). Give one with --id.`,
    );
    return 2;
  }
  const files = await manifestFiles(root);
  const platform = o.platform?.trim() || (files.length === 1 ? files[0]!.platform : undefined);
  if (!platform) {
    io.err(
      files.length
        ? `There are ${files.length} platform profiles (${files.map((f) => f.platform).join(", ")}): say which with --platform.`
        : "The org pack has no platform profile yet (org-pack/profiles/<platform>/repos.manifest.yaml). Run atticus repos discover <folder of clones>, or atticus init first.",
    );
    return 2;
  }
  let text = trimmed(o.description);
  let asked = false;
  if (!text && !o.noDescription && !o.json) {
    text = trimmed(await (deps.ask ?? askOnTerminal)(`${id}: ${ASK}`));
    asked = true;
  }
  const by = await whoFor(root, deps);
  const description = text ? written(text, by, deps.now ?? new Date()) : undefined;
  // No --type: read it from the clone's own files, and only where they say nothing, from what
  // the person just wrote (ADR 0128). Files always win, and `unknown` becomes a question.
  const detected = o.type?.trim() ? undefined : await typeOf(url.trim(), text);
  try {
    const file = await addManifestRepo(root, platform, {
      id,
      url: url.trim(),
      type: o.type?.trim() || detected?.type || "unknown",
      owner: o.owner?.trim() || "unassigned",
      ...(o.system?.trim() ? { system: o.system.trim() } : {}),
      ...(o.component?.trim() ? { component: o.component.trim() } : {}),
      ...(description ? { description } : {}),
    });
    if (o.json) {
      io.out(JSON.stringify({ repo: id, platform, file: file.rel, description }, null, 2));
      return 0;
    }
    io.out(`Added ${id} to ${file.rel}: commit it in a pull request.`);
    if (detected)
      io.out(
        `Type: ${detected.type}, from ${detected.signals.join(", ")} (${detected.confidence} confidence). Change it in the manifest if it is wrong.`,
      );
    if (description) io.out(`What it is: ${description.text}`);
    else
      io.out(
        `${id} has no description yet${asked ? "" : " (--description, or atticus repo describe)"}: atticus repo describe ${id} --description "what it is". Until then its reading prompts, the join's questions and the views have only its id to go on.`,
      );
    io.out(`Next: atticus workspace sync, then read it: /atticus-map ${id}.`);
    return 0;
  } catch (e) {
    if (e instanceof ManifestEditError) {
      io.err(e.message);
      return e.code === "not-found" ? 2 : 1;
    }
    throw e;
  }
}

/** The repos of every manifest that have no description, or one nobody has confirmed. */
export async function undescribedRepos(root: string): Promise<{
  missing: string[];
  unconfirmed: { id: string; text: string }[];
}> {
  const repos = await loadRepos(root).catch(() => []);
  const missing: string[] = [];
  const unconfirmed: { id: string; text: string }[] = [];
  for (const r of repos) {
    if (r.archived) continue;
    if (!r.description) missing.push(r.id);
    else if (r.description.trust === "suggested")
      unconfirmed.push({ id: r.id, text: r.description.text });
  }
  return { missing, unconfirmed };
}

/**
 * atticus repo describe [<repo>] [--description "..."] [--accept] [--reject] [--json]: with no
 * repo, the repos that have no description and the drafts waiting for a person; with one, set,
 * replace, confirm or reject its description. `--drafted "..." --cites file:line` is how an
 * assistant that reads a repo itself hands its draft over: it lands marked unconfirmed, as a
 * batched read's `{"about": ...}` line does, and waits for a person.
 */
export async function repoDescribe(
  root: string,
  repo: string | undefined,
  o: {
    description?: string;
    accept?: boolean;
    reject?: boolean;
    json?: boolean;
    /** A line the assistant drafted; kept as a draft, never as a person's words. */
    drafted?: string;
    /** Where it read it: "file:line" or several, comma-separated. */
    cites?: string;
  },
  io: Output,
  deps: RepoDeps = {},
): Promise<number> {
  if (!repo?.trim()) {
    const { missing, unconfirmed } = await undescribedRepos(root);
    if (o.json) {
      io.out(JSON.stringify({ missing, unconfirmed }, null, 2));
      return 0;
    }
    if (!missing.length && !unconfirmed.length) {
      io.out("Every repo of the manifests says what it is.");
      return 0;
    }
    if (missing.length) {
      io.out(`${missing.length} repo${missing.length === 1 ? " has" : "s have"} no description:`);
      for (const id of missing) io.out(`  ${id}: atticus repo describe ${id} --description "..."`);
    }
    if (unconfirmed.length) {
      io.out(
        `${unconfirmed.length} description${unconfirmed.length === 1 ? " was" : "s were"} drafted by your assistant and nobody has confirmed ${unconfirmed.length === 1 ? "it" : "them"} yet:`,
      );
      for (const u of unconfirmed)
        io.out(`  ${u.id}: "${u.text}" — atticus repo describe ${u.id} --accept`);
    }
    return 0;
  }
  const id = repo.trim();
  const found = (await loadRepos(root).catch(() => [])).find((r) => r.id === id);
  if (!found) {
    io.err(`There is no repo ${id} in any repos.manifest.yaml.`);
    return 2;
  }
  const now = deps.now ?? new Date();
  const at = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  // An assistant's own draft (tier 1, /atticus-map): kept unconfirmed, with the lines it read.
  if (o.drafted !== undefined) {
    const cites = (o.cites ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean)
      .flatMap((c) => {
        const m = /^(.*):(\d+)$/.exec(c);
        return m && Number(m[2]) > 0 ? [{ file: m[1]!, line: Number(m[2]) }] : [];
      });
    if (!cites.length) {
      io.err(
        `Say where you read it: atticus repo describe ${id} --drafted "..." --cites <file>:<line> (several separated by commas), as a fact cites its line.`,
      );
      return 2;
    }
    const r = await keepDraftedDescription(root, id, { text: o.drafted, cites }, now);
    if (o.json) {
      io.out(JSON.stringify({ repo: id, ...r }, null, 2));
      return r.kept ? 0 : 1;
    }
    if (!r.kept) {
      io.err(`The draft wasn't kept: ${r.why ?? "it wasn't one line"}.`);
      return 1;
    }
    io.out(
      `${id}: "${o.drafted.trim()}" — kept as a draft, unconfirmed, with the lines you read it from. A person confirms it (atticus repo describe ${id} --accept), changes it or drops it.`,
    );
    return 0;
  }
  let next: RepoDescription | undefined;
  if (o.reject) {
    if (!found.description) {
      io.err(`${id} has no description to reject.`);
      return 2;
    }
    next = undefined;
  } else {
    let text = trimmed(o.description);
    if (!text && o.accept) {
      if (!found.description) {
        io.err(
          `${id} has no description to confirm. Write one: atticus repo describe ${id} --description "what it is".`,
        );
        return 2;
      }
      text = found.description.text;
    }
    if (!text && !o.json) text = trimmed(await (deps.ask ?? askOnTerminal)(`${id}: ${ASK}`));
    if (!text) {
      io.err(
        `Say what ${id} is: atticus repo describe ${id} --description "what it is" (or --accept to keep the draft, --reject to drop it).`,
      );
      return 2;
    }
    // A person who writes or confirms a line owns it: it stops being a draft.
    next = written(text, await whoFor(root, deps), now);
  }
  try {
    const file = await setManifestDescription(root, id, next);
    if (o.json) {
      io.out(JSON.stringify({ repo: id, file: file.rel, description: next ?? null }, null, 2));
      return 0;
    }
    io.out(
      next
        ? `${id}: ${descriptionLine(next)}`
        : `${id}: the description was dropped; nothing says what it is now.`,
    );
    io.out(`Written to ${file.rel} at ${at}: commit it in a pull request.`);
    return 0;
  } catch (e) {
    if (e instanceof ManifestEditError) {
      io.err(e.message);
      return e.code === "not-found" ? 2 : 1;
    }
    throw e;
  }
}

/**
 * The description an assistant drafted on a first read, written into the manifest as a draft
 * (ADR 0124, 0128): marked `suggested` with the lines it was read from, so it is shown as
 * unconfirmed everywhere until a person confirms it. A repo that already says what it is keeps
 * what it says: a draft never replaces a person's words, and never a draft already on file.
 */
export async function keepDraftedDescription(
  root: string,
  repo: string,
  draft: { text: string; cites?: RepoDescriptionCite[]; by?: string },
  now: Date,
): Promise<{ kept: boolean; why?: string }> {
  const found = (await loadRepos(root).catch(() => [])).find((r) => r.id === repo);
  if (!found) return { kept: false, why: `${repo} isn't in any repos.manifest.yaml` };
  if (found.description)
    return {
      kept: false,
      why:
        found.description.trust === "verified"
          ? `${repo} already says what it is, in a person's words`
          : `${repo} already has a drafted description waiting for a person`,
    };
  const text = trimmed(draft.text);
  if (!text) return { kept: false, why: "the draft was empty" };
  const d = RepoDescription.safeParse({
    text,
    trust: "suggested",
    by: draft.by ?? "assistant",
    at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    cites: (draft.cites ?? []).slice(0, 6),
  });
  if (!d.success)
    return { kept: false, why: d.error.issues[0]?.message ?? "the draft wasn't one line" };
  await setManifestDescription(root, repo, d.data);
  return { kept: true };
}
