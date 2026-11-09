import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { changeStore } from "@maycombhq/changes";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { changeHandoff, changeNew, changeSync } from "../src/change-commands.js";
import { changeSteps, readNextState } from "../src/next-commands.js";
import { todoDone } from "../src/todo-commands.js";

/**
 * Review round 49 (end to end): on a manual Git host, `atticus todo done` of a hand-off PR's
 * step syncs the change as the app does (Home › Manual steps), so recording the merge on its
 * reviews step moves the gate on; and when a step was recorded without a sync, `next` names
 * `atticus change sync <id>`, not "the PR isn't open yet".
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const CHANGE_FIXTURES = join(HERE, "../../changes/test/fixtures/add-transfer-limit");
const CHANGE = "add-transfer-limit";
const REPO = "forge/forge-metarepo";
const NOW = "2026-11-08T09:00:00Z";
const T = 180_000;
const OPEN = `open-pr-handoff-${CHANGE}-define`;
const REPORT = `report-pr-handoff-${CHANGE}-define`;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

async function raised(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-todo-sync-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  const rt = join(root, "org-pack/runtime.yaml");
  // Round 49: the shorthand the admin guide words, `gitHost: manual`.
  await writeFile(
    rt,
    (await readFile(rt, "utf8")).replace("gitHost: { type: mock }", "gitHost: manual"),
  );
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
  await mkdir(join(root, ".github"), { recursive: true });
  await writeFile(join(root, ".github/CODEOWNERS"), "*  @forge/platform\n");
  const c = capture();
  expect(
    await changeNew(
      root,
      {
        id: CHANGE,
        title: "Add transfer limit",
        type: "feature",
        by: "pat",
        owners: ["product-owner=pat", "architect=ari", "developer=dev"],
        systems: ["ledger"],
      },
      c.io,
      { now: NOW },
    ),
  ).toBe(0);
  await cp(join(CHANGE_FIXTURES, "define"), join(root, "openspec/changes", CHANGE), {
    recursive: true,
  });
  const h = capture();
  expect(
    await changeHandoff(root, CHANGE, { by: "pat", approve: true, repo: REPO }, h.io, {
      now: NOW,
    }),
  ).toBe(0);
  return root;
}

const nextOf = async (root: string) =>
  changeSteps((await readNextState(root)).changes.find((c) => c.id === CHANGE)!)[0]!;

// Round 49: adapters that don't validate were reported as "No Git host is configured".
describe("a runtime.yaml whose adapters don't validate", () => {
  it(
    "says what doesn't validate, not that no Git host is configured",
    async () => {
      const root = await raised();
      const rt = join(root, "org-pack/runtime.yaml");
      await writeFile(
        rt,
        (await readFile(rt, "utf8")).replace("gitHost: manual", "gitHost: carrier-pigeon"),
      );
      const c = capture();
      expect(await changeSync(root, CHANGE, { by: "pat" }, c.io)).toBe(1);
      expect(c.err[0]).toMatch(
        /^org-pack\/runtime\.yaml doesn't validate, so no Git host could be set up: adapters\.gitHost: .+\. Fix it \(atticus orgpack validate says every problem\)\.$/,
      );
      expect(c.err.join("\n")).not.toContain("No Git host is configured");
    },
    T,
  );
});

describe("a manual Git host's hand-off steps from the command line", () => {
  it(
    "todo done syncs the change: the PR's link, then its merge, and the gate moves on",
    async () => {
      const root = await raised();
      expect((await nextOf(root)).command).toBe(`atticus todo --change ${CHANGE}`);
      const a = capture();
      expect(
        await todoDone(
          root,
          OPEN,
          { by: "pat", result: [`url=https://git.forge.example/${REPO}/pull/5`, "number=5"] },
          a.io,
          { now: () => new Date(NOW), sync: { now: NOW } },
        ),
      ).toBe(0);
      expect(a.out[0]).toMatch(new RegExp(`^Recorded step ${OPEN}`));
      expect(a.err.join("\n")).toContain("PR #5 can't merge yet:");
      expect(await nextOf(root)).toMatchObject({
        step: "merge",
        command: `atticus change sync ${CHANGE}`,
        pr: `https://git.forge.example/${REPO}/pull/5`,
      });

      const b = capture();
      expect(
        await todoDone(
          root,
          REPORT,
          { by: "pat", result: ["approvers=ari", "checksPassing=yes", "merged=yes"] },
          b.io,
          { now: () => new Date(NOW), sync: { now: NOW } },
        ),
      ).toBe(0);
      expect(b.out).toContain(`PR #5 merged. ${CHANGE} is now design.`);
      expect((await changeStore(root).read(CHANGE)).state).toBe("design");
    },
    T,
  );

  it(
    "a step recorded without a sync: next names atticus change sync with the metarepo",
    async () => {
      const root = await raised();
      const a = capture();
      expect(
        await todoDone(
          root,
          OPEN,
          { by: "pat", result: [`url=https://git.forge.example/${REPO}/pull/5`, "number=5"] },
          a.io,
          { now: () => new Date(NOW), sync: false },
        ),
      ).toBe(0);
      const s = await nextOf(root);
      expect(s).toMatchObject({
        step: "merge",
        command: `atticus change sync ${CHANGE} --repo ${REPO}`,
      });
      expect(s.why).not.toContain("isn't open yet");
    },
    T,
  );
});
