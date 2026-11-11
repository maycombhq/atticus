import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { verifyCommand } from "../src/verify-commands.js";

/**
 * Beta.25 (ADR 0192 addendum): a facts file a newer Atticus wrote a fact of a new kind into is
 * read, that fact left out and said ("written by a newer Atticus"), and `verify --write` keeps
 * its line in the file as written, so a teammate's fact is never lost. Review of beta.25: a slip
 * of the assistant's (a value two edits from one of its list's, a field one edit from one the kind
 * has) is no newer fact: it is refused, for the assistant to fix.
 */
const VERIFY = join(import.meta.dirname, "../../verify/test/fixtures");
const REPO = "forge-ledger";

/** A metarepo with forge-ledger read at one commit, its facts and the lines given after them. */
async function verifyWith(
  lines: (first: Record<string, unknown>, head: string) => string[],
  o: { write?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "verify-newer-"));
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
  const first = JSON.parse(text.split("\n")[0]!) as Record<string, unknown>;
  const extra = lines(first, head);
  writeFileSync(facts, `${text.trim()}\n${extra.join("\n")}\n`);
  const written = readFileSync(facts, "utf8");
  const err: string[] = [];
  const out: string[] = [];
  const code = await verifyCommand(
    root,
    REPO,
    { write: o.write ?? true },
    { out: (l) => out.push(l), err: (l) => err.push(l) },
  );
  const after = readFileSync(facts, "utf8").split("\n").filter(Boolean);
  let rejected = "";
  try {
    rejected = readFileSync(join(root, "facts", `${REPO}.rejected.jsonl`), "utf8");
  } catch {
    // no rejected file: nothing was rejected
  }
  return {
    root,
    code,
    said: [...out, ...err].join("\n"),
    err: err.join("\n"),
    after,
    rejected,
    known: text.trim().split("\n").filter(Boolean).length,
    /** The facts file as the test wrote it, before verify ran. */
    written,
  };
}

it("keeps a newer Atticus's fact in the facts file as written, and says so", async () => {
  let newer = "";
  let value = "";
  let field = "";
  let lines = "";
  const r = await verifyWith((first, head) => {
    newer = JSON.stringify({
      kind: "package",
      id: "package.forge-ledger-ui",
      repo: REPO,
      commit: head,
      cite: { file: "package.json", line: 2, value: "forge-ledger-ui" },
    });
    // review of beta.25: a known kind with a value, or a field, this version doesn't know
    value = JSON.stringify({ ...first, id: "e-get-account-v2", entryType: "carrier-pigeon" });
    field = JSON.stringify({ ...first, id: "e-get-account-v3", rateLimit: "10/s" });
    // a field one letter from `line` that is a word of its own (its plural): newer, not a slip
    lines = JSON.stringify({ ...first, id: "e-get-account-v4", lines: [3, 4] });
    return [newer, value, field, lines];
  });
  try {
    expect(r.code).toBe(0);
    expect(r.err).toContain("written by a newer Atticus");
    expect(r.err).toContain("fact package.forge-ledger-ui");
    expect(r.after).toContain(newer);
    expect(r.after).toContain(value);
    expect(r.after).toContain(field);
    expect(r.after).toContain(lines);
    expect(r.err).toContain('entryType "carrier-pigeon"');
    expect(r.err).toContain("field rateLimit is new to the entry fact");
    expect(r.err).toContain("field lines is new to the entry fact");
    // never moved to the rejected file
    for (const id of ["e-get-account-v2", "e-get-account-v3", "e-get-account-v4"])
      expect(r.rejected).not.toContain(id);
    // the facts this version reads are all still there too
    expect(r.after.length).toBe(r.known + 4);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

it("refuses a slip of a value or a field, for the assistant to fix, never keeping it as newer", async () => {
  const slips = (first: Record<string, unknown>) => [
    JSON.stringify({ ...first, id: "e-get-account-v5", conf: "declard" }),
    JSON.stringify({ ...first, id: "e-get-account-v6", verified: "lnie" }),
    JSON.stringify({ ...first, id: "e-get-account-v7", pathh: "/accounts" }),
  ];
  // The check (no --write), the read's inner loop: each slip is out of the facts file, for the
  // assistant to write again.
  const r = await verifyWith(slips, { write: false });
  try {
    expect(r.code).toBe(1);
    expect(r.said).not.toContain("written by a newer Atticus");
    expect(r.said).toContain('did you mean "declared"?');
    expect(r.said).toContain('did you mean "line"?');
    for (const id of ["e-get-account-v5", "e-get-account-v6", "e-get-account-v7"])
      expect(r.after.join("\n")).not.toContain(id);
    expect(r.after.length).toBe(r.known);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
  // Beta.26: --write refuses them too, and then leaves the facts file as it was.
  const w = await verifyWith(slips);
  try {
    expect(w.code).toBe(1);
    expect(w.said).toContain('did you mean "declared"?');
    expect(`${w.after.join("\n")}\n`).toBe(w.written);
    expect(w.err).toMatch(/so facts\/forge-ledger\.jsonl and the catalog are left as they were/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});
