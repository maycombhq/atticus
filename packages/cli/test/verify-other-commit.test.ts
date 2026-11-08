import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { verifyCommand } from "../src/verify-commands.js";

/**
 * Round 40: facts read at a commit the clone doesn't have are refused, and stay in the facts
 * file, so a second verify --write (the app's Apply clicked again) never writes a catalog
 * without the repo's records.
 */
const VERIFY = join(import.meta.dirname, "../../verify/test/fixtures");
const REPO = "forge-ledger";

it("keeps facts of another commit, and never writes the catalog without them", async () => {
  const root = mkdtempSync(join(tmpdir(), "verify-other-"));
  cpSync(join(VERIFY, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  cpSync(join(VERIFY, "metarepo/catalog"), join(root, "catalog"), { recursive: true });
  const repo = join(root, "workspace", REPO);
  cpSync(join(VERIFY, "repo"), repo, { recursive: true });
  const git = (...a: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.com",
        "-c",
        "init.defaultBranch=main",
        ...a,
      ],
      { cwd: repo, encoding: "utf8" },
    ).trim();
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "one");
  const one = git("rev-parse", "HEAD");
  mkdirSync(join(root, "facts"), { recursive: true });
  const facts = join(root, "facts", `${REPO}.jsonl`);
  const text = readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8");
  writeFileSync(facts, text.replaceAll('"commit":"0123abc"', `"commit":"${one}"`));
  const io = () => ({ out: [] as string[], err: [] as string[] });
  const count = () => {
    let n = 0;
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true }))
        if (e.isDirectory()) walk(join(d, e.name));
        else n++;
    };
    walk(join(root, "catalog", "generated"));
    return n;
  };
  const a = io();
  expect(
    await verifyCommand(
      root,
      REPO,
      { write: true },
      { out: (l) => a.out.push(l), err: (l) => a.err.push(l) },
    ),
  ).toBe(0);
  const records = count();
  const lines = () => readFileSync(facts, "utf8").split("\n").filter(Boolean).length;
  const before = lines();
  // Read in another clone, at a commit this one hasn't got.
  writeFileSync(facts, readFileSync(facts, "utf8").replaceAll(one, "1".repeat(40)));
  for (let i = 0; i < 2; i++) {
    const b = io();
    const code = await verifyCommand(
      root,
      REPO,
      { write: true, verbose: false, json: false },
      { out: (l) => b.out.push(l), err: (l) => b.err.push(l) },
    );
    expect(code, `run ${i + 1}`).not.toBe(0);
    expect(lines(), `run ${i + 1}`).toBe(before);
    expect(count(), `run ${i + 1}`).toBe(records);
  }
}, 120_000);
