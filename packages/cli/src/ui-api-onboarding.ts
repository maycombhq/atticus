import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse } from "yaml";
import { catalogDirOf, orgPackDirOf, Sources, type Api } from "@maycombhq/core";
import { readCatalog } from "@maycombhq/scanner";
import type { Router, ServerContext } from "@maycombhq/server";
import { baseClonePath, loadManifest } from "@maycombhq/workspace";
import type { z } from "zod";

/**
 * GET /api/onboarding (ADR 0084, C4): what the Onboarding and Dashboard screens show. It reads
 * files only: the manifests, the base clones' .git folders, org-pack/scan/<repo>.yaml,
 * sources.yaml and catalog/generated. It runs nothing and calls nothing.
 */

type View = z.infer<typeof Api.OnboardingView>;
type Repo = View["repos"][number];

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

const firstLine = (e: unknown) => String((e as Error).message ?? e).split("\n")[0]!;

export async function onboardingView(root: string): Promise<View> {
  const rel = (p: string) => relative(root, p).split(sep).join("/");
  const orgPack = orgPackDirOf(root);
  const problems: View["problems"] = [];

  // Manifests, one per platform profile, in folder order (the same order loadRepos reads).
  const manifests: View["manifests"] = [];
  const listed: { repo: Omit<Repo, "cloned" | "scanSettings" | "lastScan"> }[] = [];
  const profiles = join(orgPack, "profiles");
  const names = await readdir(profiles, { withFileTypes: true }).then(
    (d) =>
      d
        .filter((x) => x.isDirectory())
        .map((x) => x.name)
        .sort(),
    () => [] as string[],
  );
  const seen = new Map<string, string>();
  for (const name of names) {
    const path = join(profiles, name, "repos.manifest.yaml");
    if (!(await exists(path))) continue;
    try {
      const m = await loadManifest(path);
      manifests.push({ platform: m.platform, path: rel(path), repos: m.repos.length });
      for (const r of m.repos) {
        const other = seen.get(r.id);
        if (other) {
          problems.push({ file: rel(path), message: `repo id ${r.id} is also in ${other}` });
          continue;
        }
        seen.set(r.id, rel(path));
        listed.push({
          repo: {
            id: r.id,
            platform: m.platform,
            type: r.type,
            owner: r.owner,
            manifest: rel(path),
            // ADR 0123: the branch the catalog is read from, and those scanned beside it.
            defaultBranch: r.defaultBranch,
            branches: r.branches,
          },
        });
      }
    } catch (e) {
      problems.push({ file: rel(path), message: firstLine(e) });
    }
  }

  // What the last scan wrote, per repo: a record counts once for each repo its evidence cites.
  const catalog = await readCatalog(join(catalogDirOf(root), "generated"));
  for (const p of catalog.problems)
    problems.push({ file: rel(join(catalogDirOf(root), "generated", p.file)), message: p.message });
  const scans = new Map<string, NonNullable<Repo["lastScan"]>>();
  for (const r of catalog.records) {
    const repos = new Set(r.evidence.map((e) => e.repo).filter((x): x is string => !!x));
    for (const repo of repos) {
      const s = scans.get(repo) ?? { records: 0, kinds: {} };
      s.records += 1;
      s.kinds[r.kind] = (s.kinds[r.kind] ?? 0) + 1;
      for (const e of r.evidence) {
        if (e.repo !== repo || !e.scannedAt) continue;
        if (!s.scannedAt || e.scannedAt > s.scannedAt) {
          s.scannedAt = e.scannedAt;
          if (e.commit) s.commit = e.commit;
        }
      }
      if (!s.commit) {
        const c = r.evidence.find((e) => e.repo === repo && e.commit)?.commit;
        if (c) s.commit = c;
      }
      scans.set(repo, s);
    }
  }

  const repos: Repo[] = [];
  for (const { repo } of listed) {
    const settings = join(orgPack, "scan", `${repo.id}.yaml`);
    repos.push({
      ...repo,
      cloned: await exists(join(baseClonePath(root, repo.id), ".git")),
      scanSettings: { path: rel(settings), present: await exists(settings) },
      lastScan: scans.get(repo.id) ?? null,
    });
  }

  // Knowledge sources: sources.yaml as it is; a file that isn't valid is a problem, not a crash.
  const sourcesFile = join(orgPack, "sources.yaml");
  const sources: View["sources"] = {
    path: rel(sourcesFile),
    present: await exists(sourcesFile),
    wikis: [],
    absorbed: [],
  };
  if (sources.present) {
    try {
      const s = Sources.safeParse(parse(await readFile(sourcesFile, "utf8")));
      if (!s.success)
        problems.push({
          file: rel(sourcesFile),
          message: s.error.issues
            .map((i) => `${i.path.map(String).join(".") || "(file)"}: ${i.message}`)
            .join("; "),
        });
      else {
        sources.wikis = s.data.wikis.map((w) => ({
          id: w.id,
          type: w.type,
          location: w.location,
          spaces: w.spaces,
          ...(w.owner ? { owner: w.owner } : {}),
        }));
        sources.absorbed = s.data.absorbed.map((a) => ({
          id: a.id,
          url: a.url,
          format: a.format,
          mode: a.mode,
        }));
      }
    } catch (e) {
      problems.push({ file: rel(sourcesFile), message: `can't read YAML: ${firstLine(e)}` });
    }
  }

  return {
    manifests,
    repos,
    sources,
    catalog: { records: catalog.records.length },
    problems,
  };
}

export function uiOnboardingRoutes(r: Router, ctx: ServerContext): Router {
  return r.add("GET", "/api/onboarding", async () => ({
    status: 200,
    body: await onboardingView(ctx.root),
  }));
}
