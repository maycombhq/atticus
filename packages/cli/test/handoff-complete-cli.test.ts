import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { HandoffRuntime } from "@maycombhq/ai";
import { changesDirOf, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { featureSuggestNames } from "../src/feature-commands.js";
import { templatesDraft } from "../src/plan-commands.js";
import { completionOf, handoffDone } from "../src/workspace-commands.js";

/**
 * `feature suggest-names` and `templates draft` started in hand-off mode wait on the
 * person's assistant; `atticus handoff done <run>` then parses the answer and applies it as
 * the command would have with a model.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const FORGE_CHANGE = join(HERE, "../../../fixtures/forge-change");
const NOW = "2026-10-20T09:00:00Z";
const RECORDINGS = join(HERE, "../../planner/test/fixtures/recordings/template-writer");

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

async function forgeRoot(o: { changeOrgPack?: boolean } = {}): Promise<string> {
  const top = await mkdtemp(join(tmpdir(), "atticus-handoff-complete-"));
  const root = join(top, "metarepo");
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  if (o.changeOrgPack)
    await cp(join(FORGE_CHANGE, "org-pack"), join(root, "org-pack"), { recursive: true });
  for (const r of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(String(r.id));
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FORGE, "inputs"), join(root, "inputs"), { recursive: true });
  return root;
}

const runIdIn = async (root: string, change: string) =>
  (await readdir(join(root, ".runs", change)))[0]!;
const validate = async () => [];

describe("atticus handoff done finishes other commands' hand-off runs", () => {
  it("recognises which command a run finishes", () => {
    expect(completionOf({ change: "x", outputPath: "tasks/1.2/review-code-and-test.yaml" })).toBe(
      "hand-up",
    );
    expect(
      completionOf({ change: "features", outputPath: "catalog/proposals/feature-names.yaml" }),
    ).toBe("feature-names");
    expect(completionOf({ change: "org-pack", outputPath: "proposals/templates/prose.yaml" })).toBe(
      "templates",
    );
    expect(completionOf({ change: "x", outputPath: "stories.md" })).toBe("artifact");
  });

  it("writes feature name proposals from the assistant's answer", async () => {
    const root = await forgeRoot();
    const a = io();
    const runtime = new HandoffRuntime({ root, validate, now: () => new Date(NOW) });
    expect(await featureSuggestNames(root, { runtime }, a.io)).toBe(0);
    const runId = await runIdIn(root, "features");
    expect(a.out).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Handed the names of \\d+ features? to your assistant. When it is done, run: atticus handoff done ${runId}$`,
        ),
      ),
      "0 proposals from feature-namer; confirm one with: atticus feature name <feature> <name>",
    ]);

    // The assistant writes its answer where the prompt said, then runs handoff done.
    const out = join(changesDirOf(root), "features", "catalog/proposals/feature-names.yaml");
    await mkdir(dirname(out), { recursive: true });
    await writeFile(
      out,
      "features:\n  - id: feature.payments\n    name: Vendor payments\n    tags: [payments]\n    evidence: [if-e7344c9455608119]\n",
    );
    const d = io();
    expect(await handoffDone(root, runId, d.io, { now: () => new Date(NOW) })).toBe(0);
    expect(d.out).toEqual([
      'Wrote catalog/proposals/capability/feature.payments.yaml: feature.payments could be called "Vendor payments".',
      "1 proposal from feature-namer; confirm one with: atticus feature name <feature> <name>",
    ]);
    const proposal = parse(
      await readFile(join(root, "catalog/proposals/capability/feature.payments.yaml"), "utf8"),
    ) as Record<string, unknown>;
    expect(proposal).toMatchObject({ name: "Vendor payments", runId });
  });

  it("drafts templates again with the template writer's prose", async () => {
    const root = await forgeRoot({ changeOrgPack: true });
    await writeFile(
      join(root, "org-pack/sources.yaml"),
      "schemaVersion: 1\nwikis:\n  - { id: forge-wiki, type: markdown-folder, location: ../inputs/wiki }\n",
    );
    const runtime = new HandoffRuntime({ root, validate, now: () => new Date(NOW) });
    const a = io();
    expect(await templatesDraft(root, {}, a.io, { runtime, now: () => new Date(NOW) })).toBe(0);
    const runId = await runIdIn(root, "org-pack");
    expect(a.err).toContain(
      `  the template writer is waiting for your assistant; the drafts have no prose yet. When it is done, run: atticus handoff done ${runId}`,
    );
    const summary = join(root, "proposals/templates/SUMMARY.md");
    expect(await readFile(summary, "utf8")).not.toContain("A network firewall rule opens");

    const [recording] = await readdir(RECORDINGS);
    const answer = (
      JSON.parse(await readFile(join(RECORDINGS, recording!), "utf8")) as {
        output: string;
      }
    ).output;
    const out = join(changesDirOf(root), "org-pack", "proposals/templates/prose.yaml");
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, answer);
    const d = io();
    expect(await handoffDone(root, runId, d.io, { now: () => new Date(NOW) })).toBe(0);
    expect(d.err).toEqual([]);
    expect(d.out.at(-1)).toMatch(/^Wrote the proposal to proposals\/templates\//);
    expect(await readFile(summary, "utf8")).toContain(
      "A network firewall rule opens a connection from one of our apps",
    );
  });

  it("says what is wrong when the answer isn't YAML, and keeps the run open for another try", async () => {
    const root = await forgeRoot();
    const runtime = new HandoffRuntime({ root, validate, now: () => new Date(NOW) });
    await featureSuggestNames(root, { runtime }, io().io);
    const runId = await runIdIn(root, "features");
    const out = join(changesDirOf(root), "features", "catalog/proposals/feature-names.yaml");
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, "features: [unclosed\n");
    const d = io();
    expect(await handoffDone(root, runId, d.io)).toBe(1);
    expect(d.err[0]).toMatch(/^catalog\/proposals\/feature-names.yaml isn't YAML: /);
  });
});
