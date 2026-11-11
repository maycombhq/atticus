import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { verifyCommand } from "../src/verify-commands.js";

/**
 * Beta.25 (ADR 0192 addendum): a facts file a newer Atticus wrote a fact of a new kind into is
 * read, that fact left out and said ("written by a newer Atticus"), and `verify --write` keeps
 * its line in the file as written, so a teammate's fact is never lost.
 */
const VERIFY = join(import.meta.dirname, "../../verify/test/fixtures");
const REPO = "forge-ledger";

it("keeps a newer Atticus's fact in the facts file as written, and says so", async () => {
  const root = mkdtempSync(join(tmpdir(), "verify-newer-"));
  try {
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
    const head = git("rev-parse", "HEAD");
    mkdirSync(join(root, "facts"), { recursive: true });
    const facts = join(root, "facts", `${REPO}.jsonl`);
    const text = readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8").replaceAll(
      '"commit":"0123abc"',
      `"commit":"${head}"`,
    );
    const newer = JSON.stringify({
      kind: "package",
      id: "package.forge-ledger-ui",
      repo: REPO,
      commit: head,
      cite: { file: "package.json", line: 2, value: "forge-ledger-ui" },
    });
    writeFileSync(facts, `${text.trim()}\n${newer}\n`);
    const err: string[] = [];
    const code = await verifyCommand(
      root,
      REPO,
      { write: true },
      { out: () => {}, err: (l) => err.push(l) },
    );
    expect(code).toBe(0);
    expect(err.join("\n")).toContain("written by a newer Atticus");
    expect(err.join("\n")).toContain("fact package.forge-ledger-ui");
    const after = readFileSync(facts, "utf8").split("\n").filter(Boolean);
    expect(after).toContain(newer);
    // the facts this version reads are all still there too
    expect(after.length).toBe(text.trim().split("\n").filter(Boolean).length + 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
