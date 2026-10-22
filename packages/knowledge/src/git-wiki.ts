import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isAdopted, knowledgeRelOf, type OrgPack } from "@maycombhq/core";
import { markdownFolderAdapter, type KnowledgeSourceAdapter, type RawPage } from "./sources.js";

/**
 * A wiki kept in git (ADR 0101): an Azure DevOps or GitHub wiki, or a repo of docs. It is
 * cloned into the metarepo's local state (`workspace/knowledge/<id>`, git-ignored), or, with
 * `checkout: submodule`, kept as a submodule of the metarepo under `knowledge/repos/<id>`, so
 * the commit read is pinned in the metarepo's own history and a bump is reviewed in a pull
 * request. Either way the sync fetches the branch named (default the repository's own), checks
 * it out, and the pages are read from its folder like any Markdown folder, each dated by the
 * last commit that touched it. Git is the only thing run; nothing in the wiki is.
 */

type WikiSource = OrgPack["sources"]["wikis"][number];

/** Runs git, as @maycombhq/workspace's createGit does; injected so tests and callers choose. */
export type GitRun = (args: string[], cwd: string) => Promise<{ stdout: string }>;

export interface GitCheckout {
  source: string;
  /** The working copy. */
  dir: string;
  /** The commit read. */
  commit: string;
  /** Each file's last commit date (YYYY-MM-DD), by its path in the repository. */
  dates: Map<string, string>;
  /** A submodule's path in the metarepo, and whether the commit read differs from its pin. */
  submodule?: { path: string; moved: boolean };
}

const isUrl = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[\w.-]+@[\w.-]+:/.test(s);

/** Where the repository is: a URL as it is, a path relative to the org-pack folder. */
const urlOf = (w: WikiSource, orgPackDir: string) =>
  isUrl(w.location)
    ? w.location
    : isAbsolute(w.location)
      ? w.location
      : resolve(orgPackDir, w.location);

/** Local repositories need file transport, which newer git turns off for submodules. */
const fileOk = (url: string) => (isUrl(url) ? [] : ["-c", "protocol.file.allow=always"]);

async function datesOf(git: GitRun, dir: string, path?: string): Promise<Map<string, string>> {
  const r = await git(["log", "--format=%x01%cI", "--name-only", "--", path ?? "."], dir);
  const out = new Map<string, string>();
  let date = "";
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.startsWith("\u0001")) date = line.slice(1, 11);
    else if (line.trim() && !out.has(line.trim())) out.set(line.trim(), date);
  }
  return out;
}

async function update(git: GitRun, dir: string, url: string, ref: string | undefined) {
  await git([...fileOk(url), "fetch", "--quiet", "origin", ref ?? "HEAD"], dir);
  await git(["checkout", "--quiet", "--force", "--detach", "FETCH_HEAD"], dir);
}

/** Clone or update a git wiki, as its entry says; return where it is and what was read. */
export async function checkoutGitWiki(
  root: string,
  w: WikiSource,
  orgPackDir: string,
  git: GitRun,
): Promise<GitCheckout> {
  const url = urlOf(w, orgPackDir);
  if (w.checkout === "submodule") {
    try {
      await git(["rev-parse", "--show-toplevel"], root);
    } catch {
      throw new Error(
        `The metarepo isn't a git repository, so ${w.id} can't be added as a submodule. Run git init there, or set checkout: clone.`,
      );
    }
    const rel = `${knowledgeRelOf(root)}/repos/${w.id}`;
    const dir = join(root, ...rel.split("/"));
    if (!existsSync(join(dir, ".git"))) {
      const listed = await git(["config", "--file", ".gitmodules", "--get-regexp", "path"], root)
        .then((r) => r.stdout.split(/\r?\n/).some((l) => l.trim().endsWith(` ${rel}`)))
        .catch(() => false);
      if (listed) await git([...fileOk(url), "submodule", "update", "--init", "--", rel], root);
      else
        await git(
          [
            ...fileOk(url),
            "submodule",
            "add",
            "--quiet",
            ...(w.ref ? ["-b", w.ref] : []),
            url,
            rel,
          ],
          root,
        );
    }
    await update(git, dir, url, w.ref);
    const commit = (await git(["rev-parse", "HEAD"], dir)).stdout.trim();
    const pinned = (await git(["ls-files", "--stage", "--", rel], root)).stdout.split(/\s+/)[1];
    return {
      source: w.id,
      dir,
      commit,
      dates: await datesOf(git, dir, w.path),
      submodule: { path: rel, moved: !!pinned && pinned !== commit },
    };
  }
  const dir = join(root, ...(isAdopted(root) ? [".atticus"] : []), "workspace", "knowledge", w.id);
  if (!existsSync(join(dir, ".git"))) {
    await mkdir(dirname(dir), { recursive: true });
    await git(["clone", "--quiet", "--no-checkout", url, dir], dirname(dir));
  }
  await update(git, dir, url, w.ref);
  const commit = (await git(["rev-parse", "HEAD"], dir)).stdout.trim();
  return { source: w.id, dir, commit, dates: await datesOf(git, dir, w.path) };
}

/** Reads a git wiki's pages from its checkout, once the sync has made it. */
export function gitWikiAdapter(checkouts: Map<string, GitCheckout>): KnowledgeSourceAdapter {
  return {
    async pages(source, ctx) {
      const c = checkouts.get(source.id);
      if (!c) throw new Error(`${source.id} wasn't checked out`);
      const folder = source.path ? join(c.dir, ...source.path.split("/")) : c.dir;
      const pages: RawPage[] = await markdownFolderAdapter.pages(
        { ...source, type: "markdown-folder", location: folder },
        ctx,
      );
      return pages.map((p) => {
        const date = c.dates.get(source.path ? `${source.path}/${p.pagePath}` : p.pagePath);
        return { ...p, ...(date ? { updatedAt: date } : {}), version: c.commit };
      });
    },
  };
}
