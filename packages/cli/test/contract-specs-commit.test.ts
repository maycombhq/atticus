import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Fact } from "@maycombhq/core";
import { writeRepoSpecs } from "../src/contract-check-files.js";

/**
 * A repo's specs are read at the facts' commit (review item 13, ADR 0164): from the clone's
 * local git (`ls-tree` and `cat-file` of that commit, nothing fetched), so an edit nobody
 * committed and a file nobody added are no spec of the repo; and the commit is the one the
 * facts were read at, not the smallest name among theirs. An invented Forge repo.
 */

const git = (dir: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=Forge", "-c", "user.email=forge@example.invalid", ...args],
    { cwd: dir, encoding: "utf8" },
  ).trim();

const spec = (field: string) => `openapi: 3.0.3
info: { title: Ledger, version: "1" }
paths:
  /ledger/{id}:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  ${field}: { type: string }
`;

const PROTO =
  'syntax = "proto3";\npackage forge.ledger.v1;\nmessage Posted {\n  string id = 1;\n}\n';

const fact = (commit: string, n: number): Fact =>
  ({
    kind: "entry",
    id: `entry.get.ledger-id-${n}`,
    repo: "forge-ledger",
    commit,
    entryType: "rest",
    method: "GET",
    path: "/ledger/{id}",
    cite: { file: "src/Ledger.java", line: n, value: "/ledger/{id}" },
    verified: "line",
    by: "assistant",
    conf: "declared",
  }) as Fact;

async function clone(): Promise<{ root: string; dir: string; commits: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "atticus-specs-commit-"));
  await mkdir(join(root, "facts"), { recursive: true });
  const dir = join(root, "checkouts", "forge-ledger");
  await mkdir(join(dir, "openapi"), { recursive: true });
  git(dir, "init", "-q");
  await writeFile(join(dir, "openapi", "ledger.yaml"), spec("postedAt"));
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "one");
  const commits = [git(dir, "rev-parse", "HEAD")];
  // A second commit changes the spec; keep committing until its id sorts after the first's,
  // so the smallest name among the facts' commits is the older one.
  for (let i = 0; ; i++) {
    await writeFile(join(dir, "openapi", "ledger.yaml"), spec("settledAt"));
    git(dir, "add", ".");
    git(dir, "commit", "-q", "--allow-empty", "-m", `two ${i}`);
    const head = git(dir, "rev-parse", "HEAD");
    if (head > commits[0]!) {
      commits.push(head);
      break;
    }
  }
  return { root, dir, commits };
}

const fields = (f: Awaited<ReturnType<typeof writeRepoSpecs>>) =>
  f.specs.flatMap((s) => s.fields.map((x) => `${s.file} ${x.name}`));

describe("a repo's specs, at the facts' commit", () => {
  it("are the committed files, not an edit or a file nobody committed", async () => {
    const { root, dir, commits } = await clone();
    await writeFile(join(dir, "openapi", "ledger.yaml"), spec("draftField"));
    await mkdir(join(dir, "proto"), { recursive: true });
    await writeFile(join(dir, "proto", "posted.proto"), PROTO);
    const got = await writeRepoSpecs(root, "forge-ledger", dir, [fact(commits[1]!, 1)]);
    expect(got.commit).toBe(commits[1]);
    expect(fields(got)).toEqual(["openapi/ledger.yaml settledAt"]);
  });

  it("are read at an earlier commit the facts are of, whatever the folder holds now", async () => {
    const { root, dir, commits } = await clone();
    const got = await writeRepoSpecs(root, "forge-ledger", dir, [fact(commits[0]!, 1)]);
    expect(got.commit).toBe(commits[0]);
    expect(fields(got)).toEqual(["openapi/ledger.yaml postedAt"]);
  });

  it("take the checkout's commit when the facts have it, not the smallest name among them", async () => {
    const { root, dir, commits } = await clone();
    const facts = [fact(commits[0]!, 1), fact(commits[0]!, 2), fact(commits[1]!, 3)];
    const got = await writeRepoSpecs(root, "forge-ledger", dir, facts);
    expect(got.commit).toBe(commits[1]);
    expect(fields(got)).toEqual(["openapi/ledger.yaml settledAt"]);
  });

  it("take the commit most facts are of when none is the checkout's", async () => {
    const { root, dir, commits } = await clone();
    git(dir, "commit", "-q", "--allow-empty", "-m", "three");
    const facts = [fact(commits[0]!, 1), fact(commits[1]!, 2), fact(commits[1]!, 3)];
    expect((await writeRepoSpecs(root, "forge-ledger", dir, facts)).commit).toBe(commits[1]);
  });

  it("say so and read the checkout's commit when the facts' commit isn't in the clone", async () => {
    const { root, dir } = await clone();
    await writeFile(join(dir, "untracked.proto"), PROTO);
    const notes: string[] = [];
    const got = await writeRepoSpecs(
      root,
      "forge-ledger",
      dir,
      [fact("0123456789abcdef0123456789abcdef01234567", 1)],
      (n) => notes.push(n),
    );
    expect(fields(got)).toEqual(["openapi/ledger.yaml settledAt"]);
    expect(got.commit).toBe(git(dir, "rev-parse", "HEAD"));
    expect(notes.join("\n")).toMatch(/0123456789ab isn't in the clone/);
  });

  it("are the folder's files when the checkout isn't a git clone", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-specs-plain-"));
    const dir = join(root, "checkouts", "forge-ledger");
    await mkdir(join(dir, "openapi"), { recursive: true });
    await writeFile(join(dir, "openapi", "ledger.yaml"), spec("postedAt"));
    const got = await writeRepoSpecs(root, "forge-ledger", dir, [fact("abc1234", 1)]);
    expect(got.commit).toBe("abc1234");
    expect(fields(got)).toEqual(["openapi/ledger.yaml postedAt"]);
  });
});
