import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCritic, type CriticResult } from "../src/index.js";
import { CHANGE, NOW, changeDir, forgeChangeRoot, write } from "./helpers.js";

/**
 * The persona check of beta.30: the critic said nothing of a repo nobody read that the change has
 * work in. A repo a manifest lists that no one has read into facts, named by a `## <repo>` heading
 * of tasks.md or a row of design.md's In the code, is a risk (never blocking) with the way on. A
 * repo no manifest lists (a new one), a read repo and one the built-in readers mapped (the map has
 * it: forge-ledger, whose tasks the Forge change has) say nothing here. The Forge change.
 */

const RULE = "constitution.change-links-known";
const of = (r: CriticResult) => r.findings.filter((f) => f.finding.rule === RULE);
const A = "a".repeat(40);

/** forge-portal-bff read into facts and verified at its checkout. */
async function readBff(root: string) {
  await write(
    root,
    "facts/forge-portal-bff.jsonl",
    JSON.stringify({
      kind: "call",
      id: "bff.audit",
      repo: "forge-portal-bff",
      commit: A,
      cite: {
        file: "src/main/java/forge/portal/AuditPublisher.java",
        line: 10,
        value: "/audit/events",
      },
      verified: "line",
      callType: "rest",
      method: "POST",
      path: "/audit/events",
    }) + "\n",
  );
  await write(
    root,
    "facts/forge-portal-bff.verify.yaml",
    `accepted: 1\nrejected: 0\ncommit: ${A}\ncoverage: { ratio: 1, read: 1, unknown: [] }\n`,
  );
  await write(root, "workspace/forge-portal-bff/.git/HEAD", `${A}\n`);
}

describe("a change with work in a repo nobody read says so", () => {
  it("names the repo at its tasks.md heading and its In the code row, as a risk, with the way on", async () => {
    const root = await forgeChangeRoot();
    await readBff(root);
    await write(
      root,
      `openspec/changes/${CHANGE}/tasks.md`,
      "# Tasks\n\n## forge-portal-bff\n\n- [ ] t1 Call the limit\n\n## forge-infra\n\n- [ ] t2 Add the limit's queue\n\n## forge-limits-store\n\n- [ ] t3 Keep the limits\n\n## forge-ledger\n\n- [ ] t4 Serve the limit\n",
    );
    await appendFile(
      join(changeDir(root), "design.md"),
      "\n## In the code\n\n| Repo | Task | Has | What | Spec |\n| --- | --- | --- | --- | --- |\n| forge-events | - | other | the topic's schema | - |\n",
    );
    const f = of(await runCritic(root, CHANGE, { now: NOW }));
    expect(
      f.map((x) => [x.finding.kind, x.finding.severity, x.finding.artifact, x.finding.summary]),
    ).toEqual([
      [
        "issue",
        "risk",
        "design.md",
        "The change has work in forge-events, which nobody has read into the map, so what it says of forge-events can't be checked against its code.",
      ],
      [
        "issue",
        "risk",
        "tasks.md",
        "The change has work in forge-infra, which nobody has read into the map, so what it says of forge-infra can't be checked against its code.",
      ],
    ]);
    const infra = f.find((x) => x.finding.artifact === "tasks.md")!;
    expect(infra.finding.locator.line).toBe(7);
    expect(infra.finding.fix.text).toBe(
      "Read it into the map before its tasks run: /atticus-map forge-infra, then atticus verify forge-infra --write, and run the critic again.",
    );
    expect(infra.finding.waivable).toBe(false);
  });

  it("says nothing on the Forge change, whose repos the map has", async () => {
    expect(of(await runCritic(await forgeChangeRoot(), CHANGE, { now: NOW }))).toEqual([]);
  });
});
