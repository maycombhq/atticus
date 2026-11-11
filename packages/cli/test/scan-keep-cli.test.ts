import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CatalogRecord } from "@maycombhq/core";
import { main } from "../src/main.js";
import { carryFrom, withCarried } from "@maycombhq/scanner";
import { keptLines } from "../src/scan-commands.js";

/**
 * Beta.26 review: the cross-check with the built-in readers (`atticus scan`, Set up › Scans) on an
 * estate with no repo cloned removed every record of the catalog. The readers are a cross-check
 * beside the assistant's facts (CLAUDE.md rule 4): a scan never removes the records of a repo it
 * couldn't read (not cloned here, not asked for), nor records projected from verified facts.
 */

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");
const T = 120_000;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, stdio: "pipe" },
  )
    .toString()
    .trim();
}

async function forgeRoot(): Promise<string> {
  const top = await mkdtemp(join(tmpdir(), "atticus-cli-scan-keep-"));
  await cp(FORGE, top, { recursive: true });
  const root = join(top, "metarepo");
  for (const id of await readdir(join(top, "repos"))) {
    const dir = join(root, "workspace", id);
    await cp(join(top, "repos", id), dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "fixture");
  }
  return root;
}

/** Every record file of catalog/generated with its text. */
async function catalogFiles(root: string): Promise<Map<string, string>> {
  const dir = join(root, "catalog", "generated");
  const out = new Map<string, string>();
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith(".yaml"))
        out.set(relative(dir, full).split(sep).join("/"), await readFile(full, "utf8"));
    }
  };
  await walk(dir);
  return out;
}

const ofRepo = (files: Map<string, string>, repo: string) =>
  [...files].filter(([, text]) => text.includes(`repo: ${repo}\n`)).map(([p]) => p);

describe("the readers' cross-check keeps what it can't read", () => {
  it(
    "keeps every record when no repo is cloned here (the journeys estate)",
    async () => {
      const root = await forgeRoot();
      expect(await main(["scan", "--root", root], capture().io)).toBe(0);
      const before = await catalogFiles(root);
      expect(before.size).toBeGreaterThan(20);
      await rm(join(root, "workspace"), { recursive: true });

      const c = capture();
      expect(await main(["scan", "--root", root], c.io)).toBe(1);
      const out = c.out.join("\n");
      expect(out).toMatch(/catalog\/generated: \d+ written, \d+ unchanged, 0 removed/);
      expect(out).toMatch(
        /Kept \d+ records as they were of (forge-[a-z-]+, ){6}forge-[a-z-]+, which aren't cloned here: atticus workspace sync clones them/,
      );
      const after = await catalogFiles(root);
      for (const p of before.keys()) expect(after.has(p), p).toBe(true);
    },
    T,
  );

  it(
    "keeps a repo's records when its clone is missing, and reads the rest",
    async () => {
      const root = await forgeRoot();
      expect(await main(["scan", "--root", root], capture().io)).toBe(0);
      const before = await catalogFiles(root);
      const ledger = ofRepo(before, "forge-ledger");
      expect(ledger.length).toBeGreaterThan(1);
      await rm(join(root, "workspace", "forge-ledger"), { recursive: true });

      const c = capture();
      expect(await main(["scan", "--root", root, "--json"], c.io)).toBe(1);
      const report = JSON.parse(c.out.join("\n")) as {
        diff: { removed: { kind: string; id: string }[] };
        files: { removed: number };
        kept: { unread: string[]; records: number };
      };
      expect(report.diff.removed).toEqual([]);
      expect(report.files.removed).toBe(0);
      expect(report.kept.unread).toEqual(["forge-ledger"]);
      expect(report.kept.records).toBeGreaterThan(0);
      const after = await catalogFiles(root);
      // What rests on forge-ledger alone is kept as it was; what it shares with a repo read now
      // (a feature across repos) is made again, and still there.
      for (const p of ledger) expect(after.has(p), p).toBe(true);
      const only = ledger.filter((p) =>
        [...before.get(p)!.matchAll(/repo: (\S+)\n/g)].every((m) => m[1] === "forge-ledger"),
      );
      expect(only.length).toBeGreaterThan(1);
      for (const p of only) expect(after.get(p), p).toBe(before.get(p));
    },
    T,
  );

  it(
    "keeps the repos a scan wasn't asked to read (--repos)",
    async () => {
      const root = await forgeRoot();
      expect(await main(["scan", "--root", root], capture().io)).toBe(0);
      const before = await catalogFiles(root);
      const c = capture();
      expect(await main(["scan", "--root", root, "--repos", "forge-events"], c.io)).toBe(0);
      expect(c.out.join("\n")).toMatch(/0 removed/);
      // Item 7: said as not asked for, never as a clone to make.
      expect(c.out.join("\n")).toMatch(/which this scan wasn't asked to read \(--repos\)/);
      expect(c.out.join("\n")).not.toMatch(/cloned here|couldn't read/);
      const after = await catalogFiles(root);
      for (const p of before.keys()) expect(after.has(p), p).toBe(true);
    },
    T,
  );

  it(
    "never removes records projected from verified facts, cloned or not",
    async () => {
      const root = await forgeRoot();
      const commit = git(join(root, "workspace", "forge-ledger"), "rev-parse", "HEAD");
      const fact = (verified: string) =>
        JSON.stringify({
          kind: "entry",
          id: "e-balance",
          repo: "forge-ledger",
          commit,
          entryType: "rest",
          method: "GET",
          path: "/accounts/{id}/balance",
          auth: "oauth2",
          cite: {
            file: "src/main/java/forge/ledger/LedgerEndpoints.java",
            line: 8,
            value: "/accounts/{id}/balance",
            quote:
              '@ForgeEndpoint(method = "GET", path = "/accounts/{id}/balance", auth = "oauth2")',
          },
          verified,
          by: "assistant",
          conf: "declared",
        });
      await mkdir(join(root, "facts"), { recursive: true });
      await writeFile(join(root, "facts", "forge-ledger.jsonl"), `${fact("line")}\n`);
      expect(await main(["scan", "--root", root], capture().io)).toBe(0);
      const projected = [...(await catalogFiles(root))].filter(
        ([p, text]) => p.startsWith("endpoint/") && text.includes("by: assistant"),
      );
      expect(projected.length).toBe(1);
      const [path, text] = projected[0]!;

      // The assistant read the repo again and the verifier hasn't checked it yet: the readers
      // stand in for the scan, beside the facts' records, never over them.
      await writeFile(join(root, "facts", "forge-ledger.jsonl"), `${fact("none")}\n`);
      const c = capture();
      await main(["scan", "--root", root], c.io);
      expect((await catalogFiles(root)).get(path)).toBe(text);
      expect(c.out.join("\n")).toMatch(/Kept \d+ records? from your assistant's verified facts/);

      // Verified again, and the clone gone: still there.
      await writeFile(join(root, "facts", "forge-ledger.jsonl"), `${fact("line")}\n`);
      await rm(join(root, "workspace", "forge-ledger"), { recursive: true });
      await main(["scan", "--root", root], capture().io);
      expect((await catalogFiles(root)).get(path)).toBe(text);
    },
    T,
  );

  it(
    "never weakens or doubles a link to a repo it couldn't read (item 1)",
    async () => {
      const root = await forgeRoot();
      expect(await main(["scan", "--root", root], capture().io)).toBe(0);
      const before = await catalogFiles(root);
      const links = [...before].filter(
        ([p, text]) => p.startsWith("interface/") && text.includes("repo: forge-ledger\n"),
      );
      expect(links.length).toBeGreaterThan(0);
      await rm(join(root, "workspace", "forge-ledger"), { recursive: true });

      const c = capture();
      await main(["scan", "--root", root, "--json"], c.io);
      const report = JSON.parse(c.out.join("\n")) as {
        diff: { added: { kind: string; id: string }[]; changed: { kind: string }[] };
      };
      const after = await catalogFiles(root);
      for (const [p, text] of links) expect(after.get(p), p).toBe(text);
      // No call (an HTTP call, an event, a table's reader) is made again as a loose end or a
      // second, thinner link.
      expect(
        report.diff.added.filter((d) => d.kind === "Unresolved" || d.kind === "Interface"),
      ).toEqual([]);
      expect(report.diff.changed.filter((d) => d.kind === "Interface")).toEqual([]);
    },
    T,
  );

  it(
    "never shows a call twice while the readers stand in beside a fact's record (item 4)",
    async () => {
      const root = await forgeRoot();
      const repo = join(root, "workspace", "forge-portal-bff");
      const commit = git(repo, "rev-parse", "HEAD");
      const file = "src/main/java/forge/portal/AuditPublisher.java";
      const fact = (verified: string) =>
        `${JSON.stringify({
          kind: "call",
          id: "c-audit",
          repo: "forge-portal-bff",
          commit,
          callType: "rest",
          method: "POST",
          base: "${audit.url}",
          path: "/audit/events",
          cite: {
            file,
            line: 10,
            value: "/audit/events",
            quote: 'rest.postForObject("${audit.url}/audit/events", event, Void.class);',
          },
          verified,
          by: "assistant",
          conf: "declared",
        })}\n`;
      await mkdir(join(root, "facts"), { recursive: true });
      await writeFile(join(root, "facts", "forge-portal-bff.jsonl"), fact("line"));
      expect(await main(["scan", "--root", root], capture().io)).toBe(0);
      const ofCall = (files: Map<string, string>) =>
        [...files].filter(
          ([p, text]) =>
            (p.startsWith("unresolved/") || p.startsWith("interface/")) &&
            text.includes("/audit/events"),
        );
      const fromFacts = ofCall(await catalogFiles(root));
      expect(fromFacts.length).toBe(1);
      expect(fromFacts[0]![1]).toContain("by: assistant");

      // Read again and not verified yet: the readers stand in, and their loose end for the
      // same call is left out beside the fact's.
      await writeFile(join(root, "facts", "forge-portal-bff.jsonl"), fact("none"));
      const c = capture();
      await main(["scan", "--root", root], c.io);
      expect(ofCall(await catalogFiles(root))).toEqual(fromFacts);
      expect(c.out.join("\n")).toMatch(/Left out \d+ records? of the readers'/);
    },
    T,
  );

  it(
    "lets an archived repo's records go, as a scan always did (item 3)",
    async () => {
      const root = await forgeRoot();
      expect(await main(["scan", "--root", root], capture().io)).toBe(0);
      const before = await catalogFiles(root);
      // The profile's systems are made by every scan, whatever it reads.
      const only = [...before]
        .filter(([p, text]) => {
          if (p.startsWith("system/")) return false;
          const repos = [...text.matchAll(/repo: (\S+)\n/g)].map((m) => m[1]);
          return repos.length > 0 && repos.every((r) => r === "forge-reports-job");
        })
        .map(([p]) => p);
      expect(only.length).toBeGreaterThan(0);
      const manifest = join(root, "org-pack", "profiles", "forge", "repos.manifest.yaml");
      const text = await readFile(manifest, "utf8");
      await writeFile(
        manifest,
        text.replace(
          "    component: reports-job\n",
          "    component: reports-job\n    archived: true\n",
        ),
      );
      const c = capture();
      await main(["scan", "--root", root, "--json"], c.io);
      const report = JSON.parse(c.out.join("\n")) as {
        kept: { unread: string[]; records: number };
      };
      expect(report.kept).toMatchObject({ unread: [], records: 0 });
      const after = await catalogFiles(root);
      for (const p of only) expect(after.has(p), p).toBe(false);
    },
    T,
  );

  it(
    "lets go of fact records that cite a file changed since they were read (item 2)",
    async () => {
      const root = await forgeRoot();
      const repo = join(root, "workspace", "forge-ledger");
      const commit = git(repo, "rev-parse", "HEAD");
      const file = "src/main/java/forge/ledger/LedgerEndpoints.java";
      const quote =
        '@ForgeEndpoint(method = "GET", path = "/accounts/{id}/balance", auth = "oauth2")';
      const source = await readFile(join(repo, file), "utf8");
      expect(source.split("\n")[7]).toContain(quote);
      await mkdir(join(root, "facts"), { recursive: true });
      await writeFile(
        join(root, "facts", "forge-ledger.jsonl"),
        `${JSON.stringify({
          kind: "entry",
          id: "e-balance",
          repo: "forge-ledger",
          commit,
          entryType: "rest",
          method: "GET",
          path: "/accounts/{id}/balance",
          auth: "oauth2",
          cite: { file, line: 8, value: "/accounts/{id}/balance", quote },
          verified: "line",
          by: "assistant",
          conf: "declared",
        })}\n`,
      );
      expect(await main(["scan", "--root", root], capture().io)).toBe(0);
      const projected = [...(await catalogFiles(root))].filter(
        ([p, text]) => p.startsWith("endpoint/") && text.includes("by: assistant"),
      );
      expect(projected.length).toBe(1);

      // The file the fact cites changes and is committed: the fact is of an earlier commit and
      // cites a changed file, so it isn't carried and the readers stand in. Its record is outdated.
      await writeFile(
        join(repo, file),
        source.replace("/accounts/{id}/balance", "/accounts/{id}/funds"),
      );
      git(repo, "commit", "-q", "-am", "rename the balance route");
      const c = capture();
      await main(["scan", "--root", root], c.io);
      expect(c.out.join("\n")).toMatch(
        /Let go \d+ records? from your assistant's facts that cite a file changed/,
      );
      const after = await catalogFiles(root);
      expect([...after].some(([, t]) => t.includes("by: assistant"))).toBe(false);
    },
    T,
  );
});

const rec = (kind: string, id: string, repo: string): CatalogRecord =>
  ({
    schemaVersion: 5,
    kind,
    id,
    status: "current",
    confidence: "verified",
    evidence: [{ source: "code", repo, path: "src/a.ts", line: 1 }],
  }) as unknown as CatalogRecord;

describe("what a scan says it kept (item 7)", () => {
  it("says why each repo wasn't read, and asks to clone only one not cloned", () => {
    const carry = carryFrom({
      before: [
        rec("Endpoint", "northwind-api.get-quote", "northwind-api"),
        rec("Endpoint", "northwind-batch.get-run", "northwind-batch"),
        rec("Endpoint", "northwind-docs.get-page", "northwind-docs"),
      ],
      estate: ["northwind-api", "northwind-batch", "northwind-docs", "northwind-web"],
      read: ["northwind-web"],
      standIn: {},
      why: { "northwind-api": "not-asked", "northwind-batch": "unreadable" },
    });
    const { summary } = withCarried([], carry, 0);
    expect(summary.by).toEqual([
      { why: "not-cloned", repos: ["northwind-docs"], records: 1 },
      { why: "unreadable", repos: ["northwind-batch"], records: 1 },
      { why: "not-asked", repos: ["northwind-api"], records: 1 },
    ]);
    const lines = keptLines(summary);
    expect(lines[0]).toMatch(/of northwind-docs, which isn't cloned here: atticus workspace sync/);
    expect(lines[1]).toMatch(/of northwind-batch, whose clone couldn't be read/);
    expect(lines[2]).toMatch(/of northwind-api, which this scan wasn't asked to read \(--repos\)/);
    expect(lines[2]).not.toMatch(/clone/);
  });
});
