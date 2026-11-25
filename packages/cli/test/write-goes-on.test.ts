import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { verifyCommand } from "../src/verify-commands.js";

/**
 * ADR 0210 part 3: a write a person runs as part of the work doesn't block on what it can go
 * past. A second read that leaves a fact out keeps it while its files are unchanged, and a hand
 * edit of the catalog is kept as the person's while the write goes on. On the invented Forge
 * estate of fixtures/gateway-facts/policy-tokens; files only.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "policy-tokens");
const COMMIT: Record<string, string> = {
  "northwind_pay_1-0": "7777ccc",
  "forge-payments": "5555ddd",
  "forge-refunds": "6666eee",
  "forge-checkout": "4444fff",
};
const REPO = "forge-payments";
const AT = new Date("2026-11-24T10:00:00.000Z");
const T = 300_000;
const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function metarepo(): string {
  const root = mkdtempSync(join(tmpdir(), "atticus-goes-on-"));
  temps.push(root);
  cpSync(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  mkdirSync(join(root, "facts"), { recursive: true });
  for (const r of Object.keys(COMMIT)) {
    cpSync(join(FIX, "repos", r), join(root, "workspace", r), { recursive: true });
    writeFileSync(
      join(root, "facts", `${r}.jsonl`),
      readFileSync(join(FIX, "facts", `${r}.jsonl`), "utf8"),
    );
  }
  return root;
}
const opts = (root: string, repo: string) => ({
  commit: COMMIT[repo]!,
  dir: join(root, "workspace", repo),
  write: true,
  now: () => AT,
});
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};
async function written(): Promise<string> {
  const root = metarepo();
  for (const r of Object.keys(COMMIT))
    expect(await verifyCommand(root, r, opts(root, r), io().io)).toBe(0);
  return root;
}
const endpoints = (root: string) =>
  readdirSync(join(root, "catalog", "generated", "endpoint")).filter((f) =>
    f.startsWith("payments-api."),
  );

describe("a write that goes on (ADR 0210 part 3)", () => {
  it(
    "keeps a fact a second read left out while its files are unchanged, and says so",
    async () => {
      const root = await written();
      const before = endpoints(root);
      expect(before.length).toBe(2);
      const facts = readFileSync(join(root, "facts", `${REPO}.jsonl`), "utf8")
        .trim()
        .split("\n");
      writeFileSync(join(root, "facts", `${REPO}.jsonl`), `${facts[0]}\n`);
      const q = io();
      expect(await verifyCommand(root, REPO, opts(root, REPO), q.io)).toBe(0);
      expect(q.err.join("\n")).toMatch(
        /^Kept 1 fact of the last read that this read left out, every file it cites unchanged: entry\.post/m,
      );
      expect(endpoints(root)).toEqual(before);
    },
    T,
  );

  it(
    "keeps a hand edit of the catalog as the person's and writes, where it used to refuse",
    async () => {
      const root = await written();
      const file = join(root, "catalog", "generated", "component", "payments-api.yaml");
      const text = readFileSync(file, "utf8");
      writeFileSync(
        file,
        /^runtime: /m.test(text)
          ? text.replace(/^runtime: .*$/m, "runtime: openshift")
          : `${text.trimEnd()}\nruntime: openshift\n`,
      );
      const q = io();
      const code = await verifyCommand(root, REPO, opts(root, REPO), q.io);
      const said = [...q.out, ...q.err].join("\n");
      expect(code, said).toBe(0);
      expect(said).toMatch(
        /Kept 1 hand edit of the catalog as yours \(curated, as atticus catalog edits --curate does\)/,
      );
      expect(said).not.toMatch(/nothing is overwritten/);
      expect(readFileSync(file, "utf8")).toMatch(/^runtime: openshift$/m);
      expect(existsSync(join(root, "catalog", "curated"))).toBe(true);
    },
    T,
  );
});
