/**
 * App-only audit (archive): OpenSpec's validate passes a MODIFIED delta for a spec that doesn't
 * exist yet and says only as INFO that its archive would refuse it; `blockingIssues` makes that a
 * gate's error, so it is caught when the change is drafted. Runs the real, pinned CLI, offline.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { archiveRefuses, blockingIssues, createOpenSpec } from "../src/index.js";

const T = 60_000;
const PROPOSAL = `## Why

Customers can move unlimited amounts in a day, which the bank's risk team wants capped.

## What Changes

- Add a daily transfer limit.
`;
const delta = (op: string) => `## ${op} Requirements

### Requirement: Daily transfer limit
The system SHALL reject a transfer that takes the day's total above the account's daily limit.

#### Scenario: Over the limit
- **WHEN** a transfer would take the day's total above the limit
- **THEN** the transfer is rejected with reason LIMIT_EXCEEDED
`;

async function changeWith(op: string) {
  const root = await mkdtemp(join(tmpdir(), "atticus-openspec-refuse-"));
  const os = createOpenSpec({ root, timeoutMs: T });
  await os.init();
  const dir = join(root, "openspec/changes/add-limit");
  await mkdir(join(dir, "specs/transfers"), { recursive: true });
  await writeFile(join(dir, "proposal.md"), PROPOSAL);
  await writeFile(join(dir, "specs/transfers/spec.md"), delta(op));
  return os;
}

describe("a delta OpenSpec's archive would refuse", () => {
  it(
    "is blocking: MODIFIED for a spec openspec/specs doesn't have",
    async () => {
      const os = await changeWith("MODIFIED");
      const r = await os.validate({ item: "add-limit", type: "change", strict: true });
      const issues = r.items[0]!.issues;
      const refused = blockingIssues(issues);
      expect(refused).toHaveLength(1);
      expect(archiveRefuses(refused[0]!)).toBe(true);
      expect(refused[0]!.message).toMatch(/target spec does not exist; only ADDED/);
    },
    T,
  );

  it(
    "says nothing for ADDED on a new spec",
    async () => {
      const os = await changeWith("ADDED");
      const r = await os.validate({ item: "add-limit", type: "change", strict: true });
      expect(blockingIssues(r.items[0]!.issues)).toEqual([]);
    },
    T,
  );

  it("leaves other INFO notes alone", () => {
    expect(
      blockingIssues([{ level: "INFO", path: "x", message: "Consider splitting changes" }]),
    ).toEqual([]);
  });
});
