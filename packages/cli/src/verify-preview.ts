import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  factsDirOf,
  factsRelOf,
  headFromFiles,
  layoutOf,
  loadOrgPack,
  mapDirOf,
  mapRelOf,
  orgPackDirOf,
  parseFactsLines,
  questionsRelOf,
  recordPath,
  specRelOf,
  stackHelpersOff,
  type Api,
  type Fact,
} from "@maycombhq/core";
import { dirSource, repairFormSlips, verifyFacts } from "@maycombhq/verify";
import { stringify } from "yaml";
import { checkoutOf } from "./facts-files.js";
import { repoContractsOf } from "./link-evidence-files.js";
import { claimOf, factLabel } from "./ui-api-facts.js";
import { verifyInputsOf } from "./verify-commands.js";

/**
 * After a correction the app writes (Correct this, This link is wrong; plan item C4, ADR 0149):
 * the commands a person runs, since the app runs none (build-status B1), and what the next
 * `atticus verify <repo> --write` will change. The preview is a dry run of that command's own
 * functions (`verifyInputsOf` and `verifyFacts`, then `projectFactsIntoCatalog`), in memory:
 * nothing is written, no git runs (the checkout's HEAD is read from its `.git` files), and
 * nothing reaches the network.
 */

type View = Api.VerifyPreviewViewT;
type Preview = NonNullable<View["preview"]>;
type LinkView = Api.PreviewLinkViewT;

const sameCommit = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);
const slugPart = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

/** The pull request command for the Git host the org pack names; none for a host without one. */
export function prCommand(host: string | undefined, branch: string): string | undefined {
  switch (host) {
    case "github":
      return `gh pr create --fill --head ${branch}`;
    case "gitlab":
      return `glab mr create --fill --source-branch ${branch}`;
    case "azure-repos":
      return `az repos pr create --source-branch ${branch}`;
    default:
      return undefined;
  }
}

/** The fields of a fact a write changes: its claim's words and its line. */
function editedFields(was: Fact, now: Fact): { name: string; was?: string; now?: string }[] {
  const a: Record<string, string> = { ...claimOf(was), line: String(was.cite.line) };
  const b: Record<string, string> = { ...claimOf(now), line: String(now.cite.line) };
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .sort()
    .filter((k) => a[k] !== b[k])
    .map((k) => ({
      name: k,
      ...(a[k] !== undefined ? { was: a[k] } : {}),
      ...(b[k] !== undefined ? { now: b[k] } : {}),
    }));
}

/** The commands after a correction, in order; `add` names the exact files the write changes. */
function stepsOf(
  root: string,
  repo: string,
  o: { fact?: string; host?: string; files: readonly string[] },
): { branch: string; steps: View["steps"] } {
  const branch = `correct/${slugPart(repo)}${o.fact ? `-${slugPart(o.fact)}` : ""}`;
  const message = o.fact
    ? `${repo}: a person's correction of ${o.fact}, applied by atticus verify --write`
    : `${repo}: a person's corrections, applied by atticus verify --write`;
  const pr = prCommand(o.host, branch);
  return {
    branch,
    steps: [
      { step: "verify", command: `atticus verify ${repo} --write` },
      { step: "branch", command: `git switch -c ${branch}` },
      { step: "add", command: `git add ${o.files.join(" ")}` },
      { step: "commit", command: `git commit -m "${message}"` },
      { step: "push", command: `git push -u origin ${branch}` },
      { step: "pr", ...(pr ? { command: pr } : {}) },
    ],
  };
}

const linkView = (l: LinkView): LinkView => ({
  id: l.id,
  from: l.from,
  to: l.to,
  ...(l.method ? { method: l.method } : {}),
  path: l.path,
  confidence: l.confidence,
  ...(l.how ? { how: l.how } : {}),
  ...(l.flags?.length ? { flags: [...l.flags] } : {}),
  ...(l.was ? { was: l.was } : {}),
});

/**
 * The preview of `atticus verify <repo> --write` after a correction, with the commands. Undefined
 * when the repo has no facts file (the route says 404).
 */
export async function verifyWritePreview(
  root: string,
  repo: string,
  o: { fact?: string } = {},
): Promise<View | undefined> {
  const rel = factsRelOf(root);
  const wrote = `${rel}/${repo}.corrections.jsonl`;
  const text = await readFile(join(factsDirOf(root), `${repo}.jsonl`), "utf8").catch(
    () => undefined,
  );
  if (text === undefined) return undefined;
  const op = await loadOrgPack(orgPackDirOf(root)).catch(() => undefined);
  const host = op?.runtime.adapters.gitHost?.type;
  const base = [wrote, `${rel}/${repo}.jsonl`, `${rel}/${repo}.verify.yaml`];
  const plain = (files: string[], unavailable?: View["unavailable"]): View => ({
    repo,
    wrote,
    ...stepsOf(root, repo, { ...o, ...(host ? { host } : {}), files }),
    ...(unavailable ? { unavailable } : {}),
  });

  // As `atticus verify` reads the file: every line a fact, the reader's slips of form fixed (R6).
  const read = parseFactsLines(text);
  const repaired = repairFormSlips(read.facts, read.bad);
  if (!repaired.facts.length) return plain(base, "unreadable-facts");
  const before = repaired.facts;
  const dir = await checkoutOf(root, repo);
  if (!dir || !existsSync(dir)) return plain(base, "no-checkout");

  // No git runs here: the facts are checked at the files as the checkout has them now, and a
  // HEAD past the facts' commit is said, since verify then reads the changed files' facts again.
  const commit = [...new Set(before.map((f) => f.commit))].sort()[0];
  const head = await headFromFiles(dir);
  const off = stackHelpersOff();
  const inputs = await verifyInputsOf(root, repo);
  const report = await verifyFacts({
    facts: before,
    source: dirSource(dir),
    ...(off.has("derived-names") ? { derivedNames: false } : {}),
    ...(off.has("readers") ? { readers: false } : {}),
    exclude: inputs.exclude,
    corrections: inputs.corrections.corrections,
    reviewed: inputs.reviewed.entries,
    ...(inputs.estate ? { estate: inputs.estate } : {}),
    conventions: inputs.conventions,
  });

  const kept = new Map(report.accepted.map((f) => [f.id, f] as const));
  const wrong = new Set(
    report.corrections.applied.filter((a) => a.action === "wrong").map((a) => a.fact),
  );
  const rejected = new Map(report.rejected.map((r) => [r.fact.id, r] as const));
  const facts: Preview["facts"] = {
    dropped: before
      .filter((f) => !kept.has(f.id))
      .map((f) => ({
        id: f.id,
        kind: f.kind,
        label: factLabel(f),
        why: wrong.has(f.id) ? ("wrong" as const) : ("rejected" as const),
        ...(!wrong.has(f.id) && rejected.get(f.id) ? { message: rejected.get(f.id)!.message } : {}),
      })),
    edited: before.flatMap((f) => {
      const now = kept.get(f.id);
      const fields = now ? editedFields(f, now) : [];
      return now && fields.length
        ? [{ id: f.id, kind: f.kind, label: factLabel(now), fields }]
        : [];
    }),
    kept: report.accepted.length,
  };
  const staleCorrections = [
    ...new Set(
      report.corrections.stale.filter((s) => s.why === "none").map((s) => s.correction.fact),
    ),
  ].sort();
  const headMoved =
    head && commit && !sameCommit(head, commit) ? { head: head.slice(0, 12), commit } : undefined;
  const files = [...base];
  if (report.rejected.length || existsSync(join(factsDirOf(root), `${repo}.rejected.jsonl`)))
    files.push(`${rel}/${repo}.rejected.jsonl`);

  // verify --write puts nothing in the catalog while a fact is rejected (ADR 0124, A3b).
  if (report.rejected.length) {
    return {
      ...plain(files),
      preview: {
        facts,
        blocked: { rejected: report.rejected.length },
        ...(headMoved ? { headMoved } : {}),
        staleCorrections,
      },
    };
  }

  // Loaded here, as verify --write loads it: the catalog writer brings the scanner.
  const { projectFactsIntoCatalog } = await import("./map-render-commands.js");
  // ADR 0151: the write first reads this repo's contract files in its checkout into
  // `<repo>.contracts.yaml`; the preview reads them the same way, in memory, so it says what the
  // write will. And it keeps no read cache: it writes nothing at all.
  const contracts = await repoContractsOf(repo, dir, report.accepted);
  const companion = join(factsDirOf(root), `${repo}.contracts.yaml`);
  const onDisk = await readFile(companion, "utf8").catch(() => undefined);
  const next = contracts.entries.length ? stringify(contracts, { lineWidth: 0 }) : undefined;
  if (onDisk !== next) files.push(`${rel}/${repo}.contracts.yaml`);
  const p = await projectFactsIntoCatalog(root, repo, report.accepted, {
    ...(op ? { op } : {}),
    contracts,
    cache: false,
  });
  const catalogRel = layoutOf(root).catalog.replace(/\/+$/, "");
  const recordFiles = [
    ...p.diff.added,
    ...p.diff.changed,
    ...p.diff.removed,
    ...p.diff.evidenceOnly,
  ]
    .map((r) => `${catalogRel}/generated/${recordPath(r as { kind: never; id: string })}`)
    .sort();
  files.push(...new Set(recordFiles));
  // The folders the write renders: the repo's flows and its map, and the questions it asks.
  if (p.result.flows.length || existsSync(join(root, ...specRelOf(root, repo).split("/"))))
    files.push(specRelOf(root, repo));
  if (
    existsSync(join(mapDirOf(root), repo)) ||
    p.result.records.some((r) => r.kind === "Component")
  )
    files.push(`${mapRelOf(root)}/${repo}`);
  if (existsSync(join(root, ...questionsRelOf(root).split("/")))) files.push(questionsRelOf(root));

  // A link moved: the same call (caller, method and path) now reaches another callee. The old
  // Interface may stay, held by its callee's side alone, so it is read from the catalog itself.
  const key = (l: { from: string; method?: string | undefined; path: string }) =>
    `${l.from}|${l.method ?? ""}|${l.path}`;
  const added = p.links.added.map(linkView);
  const removed = p.links.removed.map(linkView);
  type Iface = Extract<(typeof p.existing)[number], { kind: "Interface" }>;
  const ifaces = (rs: readonly (typeof p.existing)[number][]) =>
    rs.filter((r): r is Iface => r.kind === "Interface");
  const callerHere = (r: Iface) =>
    (r.evidence as { repo?: string; side?: string }[]).some(
      (e) => e.repo === repo && e.side !== "callee",
    );
  const after = new Map(ifaces(p.result.records).map((r) => [r.id, r] as const));
  const moved: NonNullable<Preview["links"]>["moved"] = [];
  for (const a of added) {
    const old = ifaces(p.existing).find(
      (r) =>
        r.to !== a.to &&
        callerHere(r) &&
        key({ from: r.from, method: r.method, path: r.normalizedPath }) === key(a) &&
        !(after.get(r.id) && callerHere(after.get(r.id)!)),
    );
    if (old)
      moved.push({
        from: a.from,
        ...(a.method ? { method: a.method } : {}),
        path: a.path,
        was: old.to,
        to: a.to,
      });
  }
  const movedIds = new Set<string>();
  for (const m of moved) {
    const old = ifaces(p.existing).find(
      (r) =>
        r.to === m.was &&
        key({ from: r.from, method: r.method, path: r.normalizedPath }) === key(m),
    );
    if (old) movedIds.add(old.id);
  }
  const unmade: LinkView[] = ifaces(p.existing)
    .filter((r) => callerHere(r) && after.has(r.id) && !callerHere(after.get(r.id)!))
    .filter((r) => !movedIds.has(r.id))
    .map((r) => ({
      id: r.id,
      from: r.from,
      to: r.to,
      ...(r.method ? { method: r.method } : {}),
      path: r.normalizedPath,
      confidence: after.get(r.id)!.confidence,
      ...(r.flags?.length ? { flags: [...r.flags] } : {}),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const movedKeys = new Set(moved.map((m) => `${m.from}|${m.method ?? ""}|${m.path}`));
  return {
    ...plain(files),
    preview: {
      facts,
      catalog: {
        added: p.diff.added.length,
        changed: p.diff.changed.length,
        removed: p.diff.removed.length,
        evidenceOnly: p.diff.evidenceOnly.length,
        files: [...new Set(recordFiles)],
      },
      links: {
        added: added.filter((l) => !movedKeys.has(key(l))),
        removed: removed.filter((l) => !movedKeys.has(key(l))),
        changed: p.links.changed.map(linkView),
        unmade,
        moved,
      },
      ...(headMoved ? { headMoved } : {}),
      staleCorrections,
    },
  };
}
