import { execFileSync } from "node:child_process";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOSTS_STEP, listQuestions } from "@maycombhq/core";
import { readCatalog } from "@maycombhq/scanner";
import { questionsFiles } from "../src/question-commands.js";
import { scanCommand } from "../src/scan-commands.js";

const ESTATE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/estate");

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

function git(cwd: string, ...args: string[]) {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "init.defaultBranch=main",
    ].concat(args),
    { cwd, stdio: "pipe" },
  );
}

/** The two-repo estate with its owners part, cloned in workspace/, and its manifest. */
async function metarepo() {
  const root = await mkdtemp(join(tmpdir(), "atticus-hosts-cli-"));
  await cp(join(ESTATE, "org-pack"), join(root, "org-pack"), { recursive: true });
  for (const repo of ["forge-web", "forge-customers"]) {
    const dir = join(root, "workspace", repo);
    await cp(join(ESTATE, "repos", repo), dir, { recursive: true });
    await cp(join(ESTATE, "owners", "repos", repo), dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "fixture");
  }
  return root;
}

const interfaces = async (root: string) =>
  (await readCatalog(join(root, "catalog", "generated"))).records
    .filter((r) => r.kind === "Interface")
    .map((r) =>
      r.kind === "Interface" ? `${r.from}->${r.to} ${r.method} ${r.normalizedPath}` : "",
    )
    .sort();

describe("atticus scan asks which repo answers on a host (ADR 0088)", () => {
  it("asks once, writes the answer into the manifest, and the rescan joins the calls", async () => {
    const root = await metarepo();
    const s1 = io();
    expect(await scanCommand(root, { noDrift: true }, s1.io)).toBe(0);
    const asked = (await listQuestions(root, { step: HOSTS_STEP })).questions;
    expect(asked.map((q) => [q.question, q.options[0]!.label, q.evidence])).toEqual([
      [
        "Which repo answers on localhost:9966?",
        "forge-customers",
        ["src/app/owners/owner.service.ts:10", "src/app/owners/owner.service.ts:14"],
      ],
    ]);
    expect(s1.out.some((l) => l.startsWith("Calls to localhost:9966 join no repo"))).toBe(true);
    expect(await interfaces(root)).not.toContain("forge-web->forge-customers POST /owners");

    const a = io();
    expect(
      await questionsFiles(
        root,
        ["questions", "answer", asked[0]!.id, "--option", "1", "--by", "priya.nair"],
        a.io,
      ),
    ).toBe(0);
    expect(a.out.at(-1)).toBe("Next: atticus scan");

    const s2 = io();
    expect(await scanCommand(root, { noDrift: true }, s2.io)).toBe(0);
    expect(s2.out.some((l) => l.includes("localhost:9966"))).toBe(false);
    expect(await interfaces(root)).toEqual(
      expect.arrayContaining([
        "forge-web->forge-customers GET /owners",
        "forge-web->forge-customers POST /owners",
      ]),
    );
  }, 300_000);
});
