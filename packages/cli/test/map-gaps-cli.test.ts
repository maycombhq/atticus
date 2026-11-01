import { cpSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StepFact } from "../src/commands.js";
import { mapCommand } from "../src/map-commands.js";
import { verifyCommand } from "../src/verify-commands.js";

/**
 * R2 (ADR 0157): `atticus map <repo> --gaps` plans a second pass on the gaps only, for a fresh
 * session: the files the last verify found no fact citing, and the lines it listed (skipped,
 * reviewed globs holding some, spec operations no entry covers, entries no flow follows), in a
 * prompt file beside the facts. The repo is the invented Forge ledger, read in place, with three
 * of its facts written. No model, no network.
 */

const fixtures = join(__dirname, "..", "..", "verify", "test", "fixtures");
const REPO = "forge-ledger";
const COMMIT = "0123abc";
const J = "src/main/java/forge/ledger";

const io = () => {
  const out: string[] = [];
  return {
    out,
    io: {
      out: (l: string) => out.push(l),
      err: (l: string) => out.push(`ERR ${l}`),
      report: (_f: StepFact) => {},
    },
  };
};

/** The ledger with only its first three facts (two REST entries and a listener) written. */
function firstRead(): string {
  const root = mkdtempSync(join(tmpdir(), "atticus-gaps-"));
  cpSync(join(fixtures, "repo"), root, { recursive: true });
  mkdirSync(join(root, ".atticus", "org-pack"), { recursive: true });
  mkdirSync(join(root, ".atticus", "facts"), { recursive: true });
  const facts = readFileSync(join(fixtures, "forge-ledger.facts.jsonl"), "utf8")
    .split("\n")
    .slice(0, 3)
    .join("\n");
  writeFileSync(join(root, ".atticus", "facts", `${REPO}.jsonl`), `${facts}\n`);
  return root;
}

describe("atticus map <repo> --gaps (R2)", () => {
  it("asks for a verify first when there is none", async () => {
    const root = firstRead();
    const o = io();
    expect(await mapCommand(root, REPO, { gaps: true, commit: COMMIT }, o.io)).toBe(2);
    expect(o.out.join("\n")).toContain(`atticus verify ${REPO}`);
  });

  it("writes a prompt for a fresh session holding only the gaps the last verify listed", async () => {
    const root = firstRead();
    expect(await verifyCommand(root, REPO, { commit: COMMIT }, io().io)).toBe(0);
    const o = io();
    expect(await mapCommand(root, REPO, { gaps: true, commit: COMMIT }, o.io)).toBe(0);
    const said = o.out.join("\n");
    expect(said).toContain("new chat");
    expect(said).toContain(`/atticus-map ${REPO} --gaps`);
    const prompt = await readFile(join(root, ".atticus", "facts", `${REPO}.gaps.md`), "utf8");
    expect(prompt).toContain(`${REPO} at ${COMMIT}`);
    // The files no fact cites, whole; an entry no flow follows, by its lines.
    expect(prompt).toContain(`\`${J}/FxClient.java\``);
    expect(prompt).toContain("no fact cites it: read it whole");
    expect(prompt).toMatch(/EntryController\.java#L\d+-L\d+/);
    expect(prompt).toContain("e-post-entry (rest POST /accounts/{accountId}/entries)");
    // Files the facts cite and the lists don't name aren't read again.
    expect(prompt).not.toContain(`\`${J}/AccountController.java\``);
    expect(prompt).toContain(`.atticus/facts/${REPO}.jsonl`);
    expect(prompt).toContain(`atticus verify ${REPO}`);

    const j = io();
    expect(await mapCommand(root, REPO, { gaps: true, commit: COMMIT, json: true }, j.io)).toBe(0);
    const plan = JSON.parse(j.out.join("\n"));
    expect(plan.repo).toBe(REPO);
    expect(plan.session).toBe(150_000);
    expect(plan.sessions).toHaveLength(1);
    expect(plan.prompt).toBe(`.atticus/facts/${REPO}.gaps.md`);
    expect(
      plan.sessions[0].reads.some((r: { path: string }) => r.path.endsWith("FxClient.java")),
    ).toBe(true);
  });

  it("asks for a verify again when the facts changed after the last one", async () => {
    const root = firstRead();
    expect(await verifyCommand(root, REPO, { commit: COMMIT }, io().io)).toBe(0);
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(root, ".atticus", "facts", `${REPO}.jsonl`), later, later);
    const o = io();
    expect(await mapCommand(root, REPO, { gaps: true, commit: COMMIT }, o.io)).toBe(2);
    expect(o.out.join("\n")).toContain("changed since");
  });

  it("asks for a verify at the commit when the last one was of another", async () => {
    const root = firstRead();
    expect(await verifyCommand(root, REPO, { commit: COMMIT }, io().io)).toBe(0);
    const o = io();
    expect(await mapCommand(root, REPO, { gaps: true, commit: "4567def" }, o.io)).toBe(2);
    expect(o.out.join("\n")).toContain("4567def");
  });
});
