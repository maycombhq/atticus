import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { questionsDirOf } from "@maycombhq/core";
import { handoff, newChange, type HandoffPublisher } from "../src/index.js";
import { FEATURE_OWNERS, REPO, approval, copyPhase, forgeMetarepo, host } from "./helpers.js";

const question = (id: string, repo: string, command: string, state: string) =>
  [
    "schemaVersion: 4",
    `id: ${id}`,
    "askedBy:",
    "  step: context-gap",
    `  command: ${command}`,
    "  at: 2026-10-19T09:30:00Z",
    `repo: ${repo}`,
    "question: Who owns the transfer limit, and where is it described?",
    "options: []",
    "evidence:",
    "  - openspec/changes/add-transfer-limit/brief.md:1",
    "scope:",
    "  level: repo",
    `  id: ${repo}`,
    `state: ${state}`,
    `rerun: ${command}`,
    ...(state === "answered"
      ? [
          "answer:",
          "  text: The ledger team owns it.",
          "  by: pat",
          "  at: 2026-10-19T09:40:00Z",
          "  scope:",
          "    level: repo",
          `    id: ${repo}`,
        ]
      : []),
    "",
  ].join("\n");

/**
 * Seventh UX walk: the decisions a person made on a change's own questions (filed under the
 * change id in the metarepo's questions/) reach the metarepo with the change's hand-off PR,
 * never left behind as "new" in Propose after release. Open ones and other repos' don't ride.
 */
it("carries the change's answered questions with its hand-off", async () => {
  const root = await forgeMetarepo();
  await newChange(root, {
    title: "Add transfer limit",
    type: "feature",
    by: "pat",
    owners: FEATURE_OWNERS,
    systems: ["ledger", "portal"],
    now: "2026-10-19T09:00:00Z",
  });
  await copyPhase(root, "add-transfer-limit", "add-transfer-limit/define");
  const dir = questionsDirOf(root);
  await mkdir(dir, { recursive: true });
  const cmd = "atticus change feature add-transfer-limit";
  await writeFile(
    join(dir, "q-111111111111.yaml"),
    question("q-111111111111", "add-transfer-limit", cmd, "answered"),
  );
  await writeFile(
    join(dir, "q-222222222222.yaml"),
    question("q-222222222222", "add-transfer-limit", cmd, "retired"),
  );
  await writeFile(
    join(dir, "q-333333333333.yaml"),
    question("q-333333333333", "forge-ledger", "atticus verify forge-ledger --write", "answered"),
  );
  const pushed: string[][] = [];
  const publisher: HandoffPublisher = {
    publish: async (p) => {
      pushed.push(p.files);
      return { commit: "0".repeat(40) };
    },
  };
  const gh = host();
  await handoff(root, "add-transfer-limit", {
    gitHost: gh,
    repo: REPO,
    by: "pat",
    approval: approval("pat", "2026-10-19T10:00:00Z"),
    now: "2026-10-19T10:00:00Z",
    publisher,
  });
  expect(pushed).toHaveLength(1);
  expect(pushed[0]).toContain("questions/q-111111111111.yaml");
  expect(pushed[0]).not.toContain("questions/q-222222222222.yaml");
  expect(pushed[0]).not.toContain("questions/q-333333333333.yaml");
  const pr = (await gh.listPullRequests(REPO, {}))[0]!;
  expect(pr.body).toContain("- questions/q-111111111111.yaml");
});
