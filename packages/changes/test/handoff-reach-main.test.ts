import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { handoff, newChange, syncHandoff } from "../src/index.js";
import {
  FEATURE_OWNERS,
  REPO,
  approval,
  copyPhase,
  forgeMetarepo,
  host,
  passedRound,
} from "./helpers.js";

/**
 * Ninth UX walk (what reaches main): after every hand-off merged, main had no feature.md or
 * feature.yaml (the feature stage ran after the define hand-off merged, and the design hand-off
 * carried only the architecture stage's files), no stage/corrections.yaml and no task's report.
 */

const ID = "add-transfer-limit";
const T = (h: string) => `2026-10-19T${h}:00Z`;

async function put(root: string, rel: string, text = "x\n") {
  const p = join(root, "openspec/changes", ID, rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, text);
}

it("carries an earlier phase's stage files, the corrections and drafted record with the next hand-off", async () => {
  const root = await forgeMetarepo();
  const gh = host();
  await newChange(root, {
    title: "Add transfer limit",
    type: "feature",
    by: "pat",
    owners: FEATURE_OWNERS,
    systems: ["ledger", "portal"],
    now: T("09:00"),
  });
  // Define handed off from the brief, proposal and specs, before the feature stage ran.
  await copyPhase(root, ID, `${ID}/define`);
  const define = await handoff(root, ID, {
    gitHost: gh,
    repo: REPO,
    by: "pat",
    approval: approval("pat", T("10:00")),
    now: T("10:00"),
  });
  expect(define.artifacts.map((a) => a.path)).not.toContain("feature.md");
  gh.review(REPO, 1, "ari", "approved");
  await syncHandoff(root, ID, {
    gitHost: gh,
    repo: REPO,
    approval: approval("pat", T("11:00")),
    now: T("11:00"),
  });
  // The feature stage runs after the merge; then the architecture stage, with a correction.
  await copyPhase(root, ID, `${ID}/stages/define`);
  await copyPhase(root, ID, `${ID}/stages/design`);
  const arch = join(root, "openspec/changes", ID, "stage/architecture.yaml");
  await writeFile(arch, (await readFile(arch, "utf8")).replace("state: stopped", "state: done"));
  await passedRound(root, ID, "design", 3);
  await put(root, "stage/corrections.yaml");
  await put(root, "stage/drafted.yaml");
  // ADR 0191 review: the business analyst's shaping of the stories, beside their numbers, so the
  // tech lead's clone builds the same shaped stories after the plan hand-off merged.
  await put(root, "stage/stories-numbers.yaml");
  await put(root, "stage/stories-shape.yaml");
  const design = await handoff(root, ID, {
    gitHost: gh,
    repo: REPO,
    by: "ari",
    approval: approval("ari", T("12:00")),
    now: T("12:00"),
  });
  const files = design.artifacts.map((a) => a.path);
  expect(files).toEqual(
    expect.arrayContaining([
      "feature.md",
      "feature.yaml",
      "stage/feature.yaml",
      "stage/architecture.yaml",
      "stage/corrections.yaml",
      "stage/drafted.yaml",
      "stage/stories-numbers.yaml",
      "stage/stories-shape.yaml",
      "target-flows/ledger.accept-transfer.yaml",
    ]),
  );
});
