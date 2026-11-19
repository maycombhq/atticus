import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { critic, findings } from "../src/critic-commands.js";
import { readWaiting, waitingCli, type WaitingRun } from "../src/waiting-commands.js";

/**
 * Beta.30, from a trial run: after a critic round, `atticus waiting` printed
 * `finding  undefined (undefined): undefined`. It read `atticus findings <change> --json` as a
 * list of findings; that command prints each gate's newest round, with its findings inside.
 * Here the real command answers, on the Forge change, so the two can't drift apart again.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const FORGE_CHANGE = join(HERE, "../../../fixtures/forge-change");
const CHANGE = "add-transfer-limit";
const NOW = "2026-10-20T09:00:00Z";

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

async function forgeWithChange(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), "atticus-waiting-findings-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(r, "org-pack"), { recursive: true });
  await cp(join(FORGE_CHANGE, "org-pack"), join(r, "org-pack"), { recursive: true });
  await cp(join(FORGE_CHANGE, "judgments"), join(r, "judgments"), { recursive: true });
  for (const x of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...x });
    if (!p.ok) throw new Error(String(x.id));
    const f = join(r, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FORGE_CHANGE, "openspec/changes", CHANGE), join(r, "openspec/changes", CHANGE), {
    recursive: true,
  });
  return r;
}

/** The read commands `waiting` runs: findings by the real command, the rest with nothing waiting. */
const runOn =
  (root: string): WaitingRun =>
  async (argv) => {
    const key = argv.join(" ");
    if (key === `findings ${CHANGE} --json`) {
      const c = capture();
      const code = await findings(root, CHANGE, { json: true }, c.io);
      return { code, out: c.out.join("\n"), err: c.err.join("\n") };
    }
    if (key === "change list --json")
      return {
        code: 0,
        out: JSON.stringify([{ id: CHANGE, title: "Add a daily transfer limit", state: "design" }]),
        err: "",
      };
    if (key === "questions list --state open --json")
      return { code: 0, out: JSON.stringify({ questions: [] }), err: "" };
    return { code: 0, out: "[]", err: "" };
  };

describe("atticus waiting, after a critic round", () => {
  it("lists each open finding of the round by its id, severity and summary", async () => {
    const root = await forgeWithChange();
    try {
      // The deterministic layer alone: no model, no recording.
      await critic(root, CHANGE, { gate: "design" }, capture().io, { now: NOW });
      const c = capture();
      await findings(root, CHANGE, { json: true }, c.io);
      const gates = JSON.parse(c.out.join("\n")) as {
        gate: string;
        findings: { id: string; severity: string; summary: string; state: string }[];
      }[];
      const open = gates.flatMap((g) => g.findings).filter((f) => f.state === "open");
      expect(open.length).toBeGreaterThan(0);

      const w = await readWaiting(runOn(root), {});
      expect(w.problems).toEqual([]);
      expect(w.changes).toHaveLength(1);
      expect(w.changes[0]!.findings.map((f) => [f.id, f.severity, f.summary])).toEqual(
        open.map((f) => [f.id, f.severity, f.summary]),
      );
      expect(w.counts.findings).toBe(open.length);

      for (const by of ["change", "kind"] as const) {
        const p = capture();
        expect(await waitingCli({ by }, p.io, runOn(root))).toBe(0);
        expect(p.out.join("\n")).not.toContain("undefined");
      }
      const p = capture();
      await waitingCli({ by: "change" }, p.io, runOn(root));
      expect(p.out[0]).toBe(
        `Add a daily transfer limit (${CHANGE}): ${open.length} finding${open.length === 1 ? "" : "s"}`,
      );
      expect(p.out.slice(1)).toEqual(
        open.map((f) => `  finding  ${f.id} (${f.severity}): ${f.summary}`),
      );
      // A filter on a finding's own words keeps it.
      const one = await readWaiting(runOn(root), { filter: open[0]!.id });
      expect(one.changes[0]!.findings.map((f) => f.id)).toContain(open[0]!.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
