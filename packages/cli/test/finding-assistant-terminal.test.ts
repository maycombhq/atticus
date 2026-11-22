import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { Finding } from "@maycombhq/core";
import { readRound, writeGateRound } from "@maycombhq/naysayer";
import { main } from "../src/main.js";

/**
 * The owner's decision of 2026-11-22 (ADR 0115 and ADR 0203, addenda of that day): in a coding
 * assistant's terminal `atticus finding <change> <id> waive` is refused even with --by, the rule
 * the app has (it offers no Accept, and refuses one, where an assistant would be recorded). --by
 * names who is recorded; it can't make an assistant's terminal a person's. The words lead with
 * what to do. Before, --by skipped the check, so an assistant could accept a stage's finding or
 * waive a critic's in a person's name.
 */

const MARKS = ["ATTICUS_ASSISTANT", "CLAUDECODE", "GEMINI_CLI", "CURSOR_AGENT"];
const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

async function run(argv: string[], env: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "atticus-finding-assistant-"));
  made.push(root);
  const out: string[] = [];
  const err: string[] = [];
  const kept = Object.fromEntries(MARKS.map((k) => [k, process.env[k]]));
  for (const k of MARKS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    const code = await main([...argv, "--root", root], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { code, said: [...out, ...err].join("\n"), left: await readdir(root) };
  } finally {
    for (const k of MARKS)
      if (kept[k] === undefined) delete process.env[k];
      else process.env[k] = kept[k];
  }
}

const WAIVE = ["finding", "raise-limit", "stage-feature-1", "waive", "--reason", "known"];

describe("atticus finding … waive in a coding assistant's terminal", () => {
  it.each([
    [{ CLAUDECODE: "1" }, "CLAUDECODE is set"],
    [{ GEMINI_CLI: "1" }, "GEMINI_CLI is set"],
    [{ CURSOR_AGENT: "1" }, "CURSOR_AGENT is set"],
    [{ ATTICUS_ASSISTANT: "copilot" }, "ATTICUS_ASSISTANT is set"],
  ])("is refused even with --by (%o)", async (env, because) => {
    const r = await run([...WAIVE, "--by", "pat"], env);
    expect(r.code).toBe(1);
    expect(r.said).toBe(
      `Accept or waive it in a terminal of your own, or in the app: this terminal is a coding assistant's (${because}), and only a person accepts or waives a finding. --by names who is recorded; it doesn't make this terminal a person's. Nothing was written.`,
    );
    expect(r.left).toEqual([]);
  });

  it("goes on to the finding in a person's own terminal, with --by or without", async () => {
    for (const by of [["--by", "pat"], []]) {
      const r = await run([...WAIVE, ...by], {});
      expect(r.said).not.toContain("coding assistant's");
      expect(r.said).not.toContain("Recorded as");
    }
  });

  it("keeps what an assistant's own decision does with no --by: recorded as the assistant", async () => {
    const r = await run(WAIVE, { CLAUDECODE: "1" });
    expect(r.said).toContain("Recorded as claude-code: CLAUDECODE is set.");
    expect(r.said).not.toContain("--by names who is recorded");
  });
});

/**
 * The second whole-release review of beta.30 (ADR 0115 addendum, extended): `not-relevant --by`
 * on a blocking or risk finding opens its gate without a change, as a waiver does, so it is
 * refused in an assistant's terminal too. So is a fix recorded with nothing changed: `apply` of a
 * finding with no patch, and `edit-and-apply` with neither a patch nor an edited file. A real
 * fix (a patch, or a file edited) changes the draft and goes on, as does an idea's dismissal.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const FORGE_CHANGE = join(HERE, "../../../fixtures/forge-change");
const CHANGE = "add-transfer-limit";
const NOW = "2026-11-22T09:00:00Z";

const planFinding = (
  id: string,
  severity: "blocking" | "risk" | "idea",
  o: { patch?: string; artifact?: string } = {},
) =>
  Finding.parse({
    schemaVersion: 1,
    id,
    kind: "issue",
    change: CHANGE,
    gate: "plan",
    round: 1,
    rule: "ledger.limits-named",
    layer: "org",
    lens: "true",
    severity,
    artifact: o.artifact ?? "proposal.md",
    locator: { line: 1 },
    summary: `A ${severity} finding.`,
    why: "Words.",
    fix: { text: "Say it.", ...(o.patch ? { patch: o.patch } : {}) },
    evidence: [{ source: "artifact", path: o.artifact ?? "proposal.md", line: 1 }],
    waivable: true,
    state: "open",
    createdAt: NOW,
  });

async function seeded(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-finding-assistant-seeded-"));
  made.push(root);
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(FORGE_CHANGE, "org-pack"), join(root, "org-pack"), { recursive: true });
  await mkdir(join(root, "openspec/changes"), { recursive: true });
  await cp(join(FORGE_CHANGE, "openspec/changes", CHANGE), join(root, "openspec/changes", CHANGE), {
    recursive: true,
  });
  await writeGateRound(
    root,
    CHANGE,
    "plan",
    [
      planFinding("f-block", "blocking"),
      planFinding("f-risk", "risk"),
      planFinding("f-idea", "idea"),
      planFinding("f-patched", "blocking", { patch: PATCH }),
    ],
    NOW,
  );
  return root;
}

/** A fix to proposal.md's first line, as a critic's patch is written. */
const PATCH = [
  "--- a/proposal.md",
  "+++ b/proposal.md",
  "@@ -1,1 +1,1 @@",
  "-# Proposal",
  "+# Proposal: a limit on transfers",
  "",
].join("\n");

const folderOf = (root: string) => join(root, "openspec/changes", CHANGE);
const sha = (t: string) =>
  createHash("sha256").update(t.replace(/\r\n?/g, "\n"), "utf8").digest("hex");

/**
 * A stage's loop file that wrote proposal.md (its source) and design.md as they are now, so an
 * edit to either afterwards is one Atticus can see (editedByPerson).
 */
async function stageWrote(root: string) {
  const dir = folderOf(root);
  const written: Record<string, string> = {};
  for (const f of ["proposal.md", "design.md"])
    written[f] = sha(await readFile(join(dir, f), "utf8"));
  await mkdir(join(dir, "stage"), { recursive: true });
  await writeFile(
    join(dir, "stage", "feature.yaml"),
    stringify({ stage: "feature", source: "proposal.md", written }),
  );
}

async function runIn(root: string, argv: string[], env: Record<string, string>) {
  const out: string[] = [];
  const err: string[] = [];
  const kept = Object.fromEntries(MARKS.map((k) => [k, process.env[k]]));
  for (const k of MARKS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    const code = await main([...argv, "--root", root], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { code, said: [...out, ...err].join("\n") };
  } finally {
    for (const k of MARKS)
      if (kept[k] === undefined) delete process.env[k];
      else process.env[k] = kept[k];
  }
}

const WITHOUT_BY =
  "Without --by it is recorded as the assistant's proposal, which a person decides. --by names who is recorded; it doesn't make this terminal a person's. Nothing was written.";
const EDIT_REFUSED = (id: string, severity: string) =>
  `Record the fix in a terminal of your own, or in the app: this terminal is a coding assistant's (ATTICUS_ASSISTANT is set), and there is no edit Atticus can see to proposal.md and no patch, so recording ${id} as fixed would close a ${severity} finding with no change Atticus can check; only a person does that. ${WITHOUT_BY}`;

const stateOf = async (root: string, id: string) =>
  (await readRound(root, CHANGE, "plan", 1)).findings.find((s) => s.finding.id === id)!.finding
    .state;

describe("atticus finding … with --by in a coding assistant's terminal, past waive", () => {
  it.each(["f-block", "f-risk"])(
    "refuses not-relevant --by on %s, nothing written",
    async (id) => {
      const root = await seeded();
      const r = await runIn(
        root,
        ["finding", CHANGE, id, "not-relevant", "--reason", "known", "--by", "pat"],
        { CLAUDECODE: "1" },
      );
      expect(r.code).toBe(1);
      expect(r.said).toBe(
        `Decide it in a terminal of your own, or in the app: this terminal is a coding assistant's (CLAUDECODE is set), and only a person dismisses a blocking or risk finding as not relevant. ${WITHOUT_BY}`,
      );
      expect(await stateOf(root, id)).toBe("open");
    },
    60_000,
  );

  it("refuses apply --by of a finding with no patch, and edit-and-apply --by with nothing changed", async () => {
    const root = await seeded();
    const apply = await runIn(root, ["finding", CHANGE, "f-block", "apply", "--by", "pat"], {
      ATTICUS_ASSISTANT: "copilot",
    });
    expect(apply.code).toBe(1);
    expect(apply.said).toBe(
      `Record the fix in a terminal of your own, or in the app: this terminal is a coding assistant's (ATTICUS_ASSISTANT is set), and f-block has no patch, so marking it applied would close a blocking finding with nothing in the draft changed; only a person does that. ${WITHOUT_BY}`,
    );
    const edit = await runIn(
      root,
      ["finding", CHANGE, "f-risk", "edit-and-apply", "--reason", "fixed", "--by", "pat"],
      { ATTICUS_ASSISTANT: "copilot" },
    );
    expect(edit.code).toBe(1);
    expect(edit.said).toBe(EDIT_REFUSED("f-risk", "risk"));
    expect(await stateOf(root, "f-block")).toBe("open");
    expect(await stateOf(root, "f-risk")).toBe("open");
  }, 60_000);

  it("goes on for an idea's dismissal there, and for a person's own terminal", async () => {
    const root = await seeded();
    const idea = await runIn(
      root,
      ["finding", CHANGE, "f-idea", "not-relevant", "--reason", "later", "--by", "pat"],
      { CLAUDECODE: "1" },
    );
    expect(idea.code).toBe(0);
    expect(await stateOf(root, "f-idea")).toBe("dismissed");
    const own = await runIn(
      root,
      ["finding", CHANGE, "f-block", "not-relevant", "--reason", "known", "--by", "pat"],
      {},
    );
    expect(own.code).toBe(0);
    expect(await stateOf(root, "f-block")).toBe("dismissed");
  }, 60_000);
});

describe("a fix that changes the draft goes on in an assistant's terminal with --by", () => {
  const env = { ATTICUS_ASSISTANT: "copilot" };

  it("applies a finding's patch", async () => {
    const root = await seeded();
    const r = await runIn(root, ["finding", CHANGE, "f-patched", "apply", "--by", "pat"], env);
    expect(r.code).toBe(0);
    expect(await stateOf(root, "f-patched")).toBe("applied");
    expect((await readFile(join(folderOf(root), "proposal.md"), "utf8")).split("\n")[0]).toBe(
      "# Proposal: a limit on transfers",
    );
  }, 60_000);

  it("records edit-and-apply after a real edit to the finding's own file", async () => {
    const root = await seeded();
    await stageWrote(root);
    const file = join(folderOf(root), "proposal.md");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace("# Proposal", "# Proposal, fixed"),
    );
    const r = await runIn(
      root,
      ["finding", CHANGE, "f-risk", "edit-and-apply", "--reason", "named the limit", "--by", "pat"],
      env,
    );
    expect(r.code).toBe(0);
    expect(r.said).toContain("Recorded your edit to proposal.md");
    expect(await stateOf(root, "f-risk")).toBe("applied");
  }, 60_000);

  it("doesn't count an edit to another file than the finding's", async () => {
    const root = await seeded();
    await stageWrote(root);
    const other = join(folderOf(root), "design.md");
    await writeFile(other, `${await readFile(other, "utf8")}\nMore design.\n`);
    const r = await runIn(
      root,
      ["finding", CHANGE, "f-risk", "edit-and-apply", "--reason", "fixed", "--by", "pat"],
      env,
    );
    expect(r.code).toBe(1);
    expect(r.said).toBe(EDIT_REFUSED("f-risk", "risk"));
    expect(await stateOf(root, "f-risk")).toBe("open");
  }, 60_000);
});
