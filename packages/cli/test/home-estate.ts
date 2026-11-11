import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  interfaceId,
  parseRecord,
  QuestionDraft,
  raiseQuestions,
  recordPath,
  serializeRecord,
} from "@maycombhq/core";
import { initCommand } from "../src/setup-commands.js";
import { changeNew } from "../src/change-commands.js";

/**
 * A Forge estate at the size people run Atticus on (beta.23, "Home loads fast"): 40 repos, each
 * a system of one component with `per` endpoints and `per` calls (about 40 × (2 + 2·per)
 * catalog records), `facts` facts per repo, `questions` open questions per repo, a few changes
 * in flight, and each repo's base clone a small Git repo under workspace/. Invented names only.
 */
export async function makeHomeEstate(
  dir: string,
  o: {
    repos?: number;
    per?: number;
    facts?: number;
    questions?: number;
    changes?: number;
    proposed?: number;
  } = {},
): Promise<string> {
  const REPOS = o.repos ?? 40;
  const PER = o.per ?? 30;
  const FACTS = o.facts ?? 300;
  const QS = o.questions ?? 5;
  const CHANGES = o.changes ?? 4;
  const quiet = { out: () => undefined, err: () => undefined };
  const root = join(dir, "forge");
  if ((await initCommand(root, { name: "forge", platform: "github", owner: "pat" }, quiet)) !== 0)
    throw new Error("atticus init failed");
  const repos = Array.from({ length: REPOS }, (_, r) => `forge-svc-${r}`);
  await writeFile(
    join(root, "org-pack/profiles/github/repos.manifest.yaml"),
    [
      "schemaVersion: 3",
      "platform: github",
      "repos:",
      ...repos.flatMap((id) => [
        `  - id: ${id}`,
        `    url: https://git.example.test/forge/${id}.git`,
        "    type: spring-boot",
        "    owner: team-forge",
        `    system: ${id}`,
      ]),
      "",
    ].join("\n"),
  );
  const writes: Promise<void>[] = [];
  const put = (r: Record<string, unknown>) => {
    const p = parseRecord({ schemaVersion: 1, status: "current", confidence: "verified", ...r });
    if (!p.ok) throw new Error(`bad record ${JSON.stringify(r)}: ${JSON.stringify(p)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    writes.push(
      mkdir(dirname(f), { recursive: true }).then(() => writeFile(f, serializeRecord(p.record))),
    );
  };
  for (const [s, sys] of repos.entries()) {
    const comp = `${sys}-api`;
    const ev = [{ source: "code", repo: sys, path: "src/App.java", line: 1 }];
    put({
      kind: "System",
      id: sys,
      name: sys,
      boundary: "product",
      owner: "team-forge",
      repos: [sys],
      evidence: ev,
    });
    put({ kind: "Component", id: comp, system: sys, repo: sys, type: "spring-boot", evidence: ev });
    for (let e = 0; e < PER; e++) {
      put({
        kind: "Endpoint",
        id: `${comp}.op-${e}`,
        component: comp,
        endpointType: "rest",
        method: "GET",
        pathOrTopic: `/v1/items-${e}/{id}`,
        normalizedPath: `/v1/items-${e}/{}`,
        evidence: [{ ...ev[0], side: "callee" }],
      });
      const to = `forge-svc-${(s + 1 + (e % (REPOS - 1))) % REPOS}-api`;
      put({
        kind: "Interface",
        id: interfaceId(comp, to, "GET", `/v1/items-${e}/{}`),
        from: comp,
        to,
        endpoint: `${to}.op-${e}`,
        via: "direct",
        method: "GET",
        normalizedPath: `/v1/items-${e}/{}`,
        sync: "sync",
        evidence: [{ ...ev[0], side: "caller" }],
      });
    }
    const lines: string[] = [];
    for (let i = 0; i < FACTS; i++)
      lines.push(
        JSON.stringify({
          kind: "call",
          id: `c-op-${i}`,
          repo: sys,
          commit: "1111aaa",
          callType: "rest",
          method: "GET",
          path: `/v1/items-${i}/{id}`,
          from: "e-main",
          cite: {
            file: `src/main/java/forge/Client${i % 50}.java`,
            line: 10 + (i % 400),
            value: `/v1/items-${i}/{id}`,
            quote: `restTemplate.getForObject("/v1/items-${i}/{id}", Item.class);`,
          },
          verified: "line",
          by: "assistant",
          conf: "declared",
        }),
      );
    writes.push(
      mkdir(join(root, "facts"), { recursive: true }).then(() =>
        writeFile(join(root, "facts", `${sys}.jsonl`), lines.join("\n") + "\n"),
      ),
    );
    // The base clone: a small Git repo with one commit, as atticus workspace sync leaves it.
    const clone = join(root, "workspace", sys);
    writes.push(
      mkdir(join(clone, "src"), { recursive: true }).then(async () => {
        await writeFile(join(clone, "src/App.java"), "class App {}\n");
        execFileSync("git", ["init", "-q", "-b", "main"], { cwd: clone });
        execFileSync("git", ["add", "."], { cwd: clone });
        execFileSync(
          "git",
          ["-c", "user.name=pat", "-c", "user.email=pat@example.test", "commit", "-qm", "init"],
          { cwd: clone },
        );
      }),
    );
  }
  await Promise.all(writes);
  for (const sys of repos)
    await raiseQuestions(
      root,
      Array.from({ length: QS }, (_, q) =>
        QuestionDraft.parse({
          question: `Which system serves GET /v1/items-${q}/{id} for ${sys}?`,
          options: [
            { label: "forge-ledger", means: "the ledger serves it", changes: "the call joins it" },
            { label: "Outside", means: "a vendor", changes: "the call is drawn outside" },
          ],
          evidence: [`src/main/java/forge/Client${q}.java:${10 + q}`],
        }),
      ),
      {
        step: "scan-survey",
        repo: sys,
        command: `atticus scan survey ${sys}`,
        rerun: `atticus scan survey ${sys} --force`,
        at: "2026-11-06T12:00:00.000Z",
      },
    );
  for (let c = 0; c < CHANGES; c++)
    if (
      (await changeNew(
        root,
        { title: `Add a limit to items ${c}`, type: "feature", by: "pat" },
        quiet,
      )) !== 0
    )
      throw new Error("atticus change new failed");
  // Committed, as a metarepo is; then `proposed` answered questions proposed for review and not
  // merged yet (changed here, on a proposal branch the remote has), as after Propose for review.
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=pat", "-c", "user.email=pat@example.test", ...args], {
      cwd: root,
      encoding: "utf8",
    });
  git("add", "-A");
  git("commit", "-qm", "the estate");
  const proposed: Record<string, { blob: string; where: string; branch: string }> = {};
  const names = (await readdir(join(root, "questions"))).filter((n) => n.endsWith(".yaml")).sort();
  const branch = "propose/work/2026-11-09-pat";
  git("update-ref", `refs/remotes/origin/${branch}`, "HEAD");
  for (const n of names.slice(0, o.proposed ?? 100)) {
    const rel = `questions/${n}`;
    await appendFile(join(root, rel), "# answered on Home\n");
    proposed[rel] = { blob: git("hash-object", "--", rel).trim(), where: branch, branch };
  }
  await mkdir(join(root, ".index"), { recursive: true });
  await writeFile(join(root, ".index", "proposed.json"), JSON.stringify(proposed));
  return root;
}

/**
 * Every request Home (CommandCenter and its panels) sends as it opens, in the order it sends them.
 * beta.26: Home is one screen; the system map left it for its tile, so it asks for no graph or
 * diagram (/api/graph and /api/diagram/context/graph were the last two here).
 */
export const HOME_REQUESTS = [
  "/api/health",
  "/api/me",
  "/api/search?q=kind:table&limit=1",
  "/api/settings/ai",
  "/api/setup",
  "/api/changes",
  "/api/findings?state=open",
  "/api/catalog/kinds",
  "/api/owner-questions",
  "/api/view/triage",
  "/api/todo",
  "/api/questions?state=open",
  "/api/onboarding",
  "/api/trust",
  "/api/knowledge/items",
  "/api/upgrade",
  "/api/propose?scope=work",
  "/api/decisions",
];

/** What Home asks of each change in flight (its needs, its role's questions), and of the first its cockpit. */
export const homeChangeRequests = (changes: readonly string[]): string[] => [
  ...changes.flatMap((c) => [`/api/changes/${c}/needs`, `/api/questions?state=open&change=${c}`]),
  ...(changes[0] ? [`/api/changes/${changes[0]}/cockpit`] : []),
];

/**
 * What Home asks again when it hears a change (CommandCenter's useFileChanges and the panels'
 * useReloadOnFiles): the catalog's counts only when the catalog may have changed.
 */
export const homeReloads = (changes: readonly string[], catalog: boolean): string[] => [
  "/api/changes",
  "/api/findings?state=open",
  "/api/owner-questions",
  "/api/todo",
  "/api/questions?state=open",
  "/api/onboarding",
  "/api/trust",
  "/api/knowledge/items",
  "/api/upgrade",
  "/api/decisions",
  ...(catalog ? ["/api/catalog/kinds"] : []),
  ...homeChangeRequests(changes),
];
