import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { loadOrgPack, RecordId, type BuildEngine, type OrgPack } from "@maycombhq/core";
import { loadRepos, readChangeRepos } from "@maycombhq/workspace";
import {
  renderAssistantFiles,
  type OrgCommand,
  type Profile,
  type RenderedFile,
} from "./render.js";
import { writeAssistantFiles, type WriteReport } from "./write.js";

/**
 * Org-pack commands: `org-pack/process/commands/<id>.md`, YAML front matter then the
 * instructions. C6 has no schema for these yet (a candidate additive addition), so this
 * package validates them with its own and reports problems instead of failing.
 */
export const OrgCommandMeta = z.strictObject({
  id: RecordId,
  description: z.string().min(1),
  argumentHint: z.string().min(1).optional(),
  appliesTo: z
    .strictObject({ repoTypes: z.array(RecordId).default([]) })
    .default({ repoTypes: [] }),
});

export async function loadOrgCommands(
  orgPackDir: string,
): Promise<{ commands: OrgCommand[]; problems: string[] }> {
  const commands: OrgCommand[] = [];
  const problems: string[] = [];
  let names: string[];
  try {
    names = (await readdir(join(orgPackDir, "process", "commands")))
      .filter((n) => n.endsWith(".md"))
      .sort();
  } catch {
    return { commands, problems };
  }
  for (const n of names) {
    const file = `process/commands/${n}`;
    const text = (await readFile(join(orgPackDir, file), "utf8")).replace(/\r\n/g, "\n");
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
    if (!m) {
      problems.push(`org-pack/${file}: a command starts with YAML front matter between --- lines`);
      continue;
    }
    let data: unknown;
    try {
      data = parse(m[1]!);
    } catch (e) {
      problems.push(
        `org-pack/${file}: front matter is not valid YAML: ${(e as Error).message.split("\n")[0]}`,
      );
      continue;
    }
    const r = OrgCommandMeta.safeParse(data);
    if (!r.success) {
      problems.push(
        `org-pack/${file}: ${r.error.issues.map((i) => `${i.path.join(".") || "(front matter)"}: ${i.message}`).join("; ")}`,
      );
      continue;
    }
    if (`${r.data.id}.md` !== n)
      problems.push(`org-pack/${file}: id ${r.data.id} doesn't match the file name`);
    if (!m[2]!.trim()) {
      problems.push(`org-pack/${file}: a command needs instructions after the front matter`);
      continue;
    }
    commands.push({
      id: r.data.id,
      description: r.data.description,
      ...(r.data.argumentHint ? { argumentHint: r.data.argumentHint } : {}),
      repoTypes: r.data.appliesTo.repoTypes,
      body: m[2]!,
      file,
    });
  }
  return { commands, problems };
}

/** The build engine for a repo: runtime.yaml's per-repo choice, else its default, else speckit. */
export function buildEngineFor(orgPack: Pick<OrgPack, "runtime">, repo: string): BuildEngine {
  const be = orgPack.runtime.buildEngine;
  return be?.perRepo[repo] ?? be?.default ?? "speckit";
}

export class AssistantFilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantFilesError";
  }
}

export interface GenerateOptions {
  /** A code repo id from repos.manifest.yaml: write into that repo's change worktree. */
  repo?: string;
  /** Which change's worktree, when the repo is open in more than one change. */
  change?: string;
  /** Write here instead (hand-down passes the worktree it is working in). */
  dir?: string;
  force?: boolean;
  check?: boolean;
}

export interface GenerateResult extends WriteReport {
  /** Folder written to. */
  dir: string;
  profile: Profile;
  files: RenderedFile[];
  problems: string[];
}

async function worktreeFor(root: string, repo: string, change?: string): Promise<string> {
  let changes: string[] = [];
  try {
    changes = (await readdir(join(root, "openspec", "changes"), { withFileTypes: true }))
      .filter((d) => d.isDirectory() && d.name !== "archive")
      .map((d) => d.name)
      .sort();
  } catch {
    // no changes yet
  }
  const open: { change: string; worktree: string }[] = [];
  for (const c of change ? [change] : changes) {
    const r = (await readChangeRepos(root, c).catch(() => undefined))?.repos.find(
      (x) => x.id === repo,
    );
    if (r) open.push({ change: c, worktree: r.worktree });
  }
  if (open.length === 1) return join(root, open[0]!.worktree);
  if (open.length === 0)
    throw new AssistantFilesError(
      change
        ? `${repo} has no worktree in change ${change}; open it with atticus workspace open ${change}.`
        : `${repo} isn't open in any change; open one with atticus workspace open <change>, or pass --change.`,
    );
  throw new AssistantFilesError(
    `${repo} is open in ${open.length} changes (${open.map((o) => o.change).join(", ")}); pass --change.`,
  );
}

/**
 * Generate the assistant files for the metarepo (no repo) or for one code repo's worktree,
 * from the org pack's one skill source. Base clones are never written.
 */
export async function generateAssistantFiles(
  root: string,
  o: GenerateOptions = {},
): Promise<GenerateResult> {
  const orgPackDir = join(root, "org-pack");
  const orgPack = await loadOrgPack(orgPackDir);
  const { commands, problems } = await loadOrgCommands(orgPackDir);
  problems.unshift(
    ...orgPack.problems
      .filter(
        (p) =>
          p.file.startsWith("process/skills/") ||
          p.file.startsWith("agents/") ||
          p.file === "runtime.yaml",
      )
      .map((p) => `org-pack/${p.file}: ${p.path ? `${p.path}: ` : ""}${p.message}`),
  );
  let profile: Profile = { kind: "metarepo" };
  let dir = o.dir ?? root;
  if (o.repo) {
    const repo = (await loadRepos(root)).find((r) => r.id === o.repo);
    if (!repo)
      throw new AssistantFilesError(`There is no repo ${o.repo} in any repos.manifest.yaml.`);
    profile = {
      kind: "repo",
      repo: repo.id,
      repoType: repo.type,
      engine: buildEngineFor(orgPack, repo.id),
    };
    if (!o.dir) dir = await worktreeFor(root, repo.id, o.change);
  }
  const files = renderAssistantFiles({ orgPack, commands, profile });
  const report = await writeAssistantFiles(dir, files, {
    ...(o.force ? { force: true } : {}),
    ...(o.check ? { check: true } : {}),
  });
  return { ...report, dir, profile, files, problems };
}
