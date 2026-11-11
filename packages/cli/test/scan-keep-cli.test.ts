import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CatalogRecord } from "@maycombhq/core";
import { main } from "../src/main.js";
import { keepWhatTheReadersCantSee } from "../src/scan-keep.js";

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
      expect(out).toMatch(/Kept \d+ records of 7 repos this scan couldn't read/);
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
});

const rec = (kind: string, id: string, evidence: Record<string, unknown>[]): CatalogRecord =>
  ({
    schemaVersion: 5,
    kind,
    id,
    status: "current",
    confidence: "verified",
    evidence,
  }) as unknown as CatalogRecord;

const code = (repo: string, extra: Record<string, unknown> = {}) => ({
  source: "code",
  repo,
  path: "src/a.ts",
  line: 1,
  ...extra,
});

describe("keepWhatTheReadersCantSee", () => {
  const base = {
    manifest: ["northwind-api", "northwind-web"],
    read: ["northwind-web"],
    standIn: [] as string[],
  };

  it("keeps a record of a repo it couldn't read, and lets the rest go", () => {
    const before = [
      rec("Endpoint", "northwind-api.get-quote", [code("northwind-api")]),
      rec("Endpoint", "northwind-web.get-page", [code("northwind-web")]),
      rec("Endpoint", "gone-repo.get-x", [code("gone-repo")]),
    ];
    const r = keepWhatTheReadersCantSee({ ...base, before, scanned: [] });
    expect(r.records.map((x) => x.id)).toEqual(["northwind-api.get-quote"]);
    expect(r.unread).toEqual(["northwind-api"]);
    expect(r.keptUnread).toBe(1);
    expect(r.keptFacts).toBe(0);
  });

  it("keeps a link between a repo it read and one it couldn't", () => {
    const link = rec("Interface", "if-1", [
      code("northwind-web", { side: "caller" }),
      code("northwind-api", { side: "callee" }),
    ]);
    const r = keepWhatTheReadersCantSee({ ...base, before: [link], scanned: [] });
    expect(r.records).toEqual([link]);
  });

  it("prefers the earlier record over the scan's when only unread repos made it", () => {
    const old = rec("Component", "northwind-api", [code("northwind-api")]);
    const thin = rec("Component", "northwind-api", [{ source: "manual", by: "manifest" }]);
    const r = keepWhatTheReadersCantSee({ ...base, before: [old], scanned: [thin] });
    expect(r.records).toEqual([old]);
  });

  it("keeps a record from verified facts while the readers stand in, beside theirs", () => {
    const fromFacts = rec("Endpoint", "northwind-web.get-page", [
      code("northwind-web", { by: "assistant", commit: "abc1234" }),
    ]);
    const readersSame = rec("Endpoint", "northwind-web.get-page", [
      code("northwind-web", { extractor: "spring@1" }),
    ]);
    const readersNew = rec("Endpoint", "northwind-web.get-other", [
      code("northwind-web", { extractor: "spring@1" }),
    ]);
    const r = keepWhatTheReadersCantSee({
      ...base,
      standIn: ["northwind-web"],
      before: [fromFacts],
      scanned: [readersSame, readersNew],
    });
    expect(r.records).toEqual([readersNew, fromFacts].sort((a, b) => (a.id < b.id ? -1 : 1)));
    expect(r.keptFacts).toBe(1);
  });

  it("lets facts drive removals once the repo is read from its facts", () => {
    const fromFacts = rec("Endpoint", "northwind-web.get-page", [
      code("northwind-web", { by: "assistant" }),
    ]);
    const r = keepWhatTheReadersCantSee({ ...base, before: [fromFacts], scanned: [] });
    expect(r.records).toEqual([]);
  });

  it("never keeps a person's or a document's record by these rules", () => {
    const manual = rec("Decision", "d-1", [{ source: "manual", by: "tom" }]);
    const r = keepWhatTheReadersCantSee({ ...base, before: [manual], scanned: [] });
    expect(r.records).toEqual([]);
  });
});
