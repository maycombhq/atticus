import { cp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OpenSpecError, type OpenSpec, type ValidationReport } from "@maycombhq/openspec-adapter";
import { archiveChange, changeStore, ChangeError, requireValid } from "../src/index.js";
import { forgeMetarepo } from "./helpers.js";

/**
 * App-only audit (archive): the archive is all or nothing. A delta OpenSpec's archive would refuse
 * (a MODIFIED for a spec that doesn't exist) is refused by the gate that validates, with OpenSpec's
 * words and what to do; and an archive OpenSpec refuses anyway leaves the change as it was.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE_CHANGE = join(HERE, "../../../fixtures/forge-change");
const ID = "add-transfer-limit";
const REFUSE =
  "Archive would refuse this delta: transfers: target spec does not exist; only ADDED requirements are allowed for new specs. MODIFIED and RENAMED operations require an existing spec.";

async function released() {
  const root = await forgeMetarepo();
  const dir = join(root, "openspec/changes", ID);
  await cp(join(FORGE_CHANGE, "openspec/changes", ID), dir, { recursive: true });
  const p = join(dir, "change.yaml");
  const path = ["plan", "build", "qa", "release-ready", "released"];
  const entries = path
    .slice(1)
    .map(
      (to, i) =>
        `  - from: ${path[i]}\n    to: ${to}\n    at: 2026-10-2${i}T10:00:00Z\n    by: tia\n    reason: Moved on for the test`,
    )
    .join("\n");
  await writeFile(
    p,
    (await readFile(p, "utf8"))
      .replace(/^state: plan$/m, "state: released")
      .replace(/( {4}reason: Approve design merged\n)/, `$1${entries}\n`),
  );
  return root;
}

const report = (issues: ValidationReport["items"][number]["issues"]): ValidationReport => ({
  items: [{ id: ID, type: "change", valid: true, issues }],
  summary: { totals: { items: 1, passed: 1, failed: 0 } },
});

function fakeOpenSpec(o: {
  issues?: ValidationReport["items"][number]["issues"];
  archive?: () => never;
}) {
  return {
    root: "/x",
    validate: async () => report(o.issues ?? []),
    archive: async () => {
      if (o.archive) o.archive();
      return { change: ID, archivedAs: `2026-11-09-${ID}`, path: "x", specsUpdated: true };
    },
  } as unknown as OpenSpec;
}

describe("archive, all or nothing (app-only audit)", () => {
  it("the gate refuses a delta OpenSpec's archive would refuse, though validate passed it", async () => {
    const os = fakeOpenSpec({
      issues: [{ level: "INFO", path: "transfers/spec.md", message: REFUSE }],
    });
    const e = await requireValid(os, ID).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ChangeError);
    const reasons = (e as ChangeError).reasons;
    expect(reasons).toHaveLength(1);
    expect(reasons[0]!.message).toContain("target spec does not exist");
    expect(reasons[0]!.message).toContain("## ADDED Requirements");
    // Other INFO notes don't hold it.
    await expect(
      requireValid(
        fakeOpenSpec({
          issues: [{ level: "INFO", path: "x", message: "Consider splitting changes" }],
        }),
        ID,
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses before archiving, leaving the change released", async () => {
    const root = await released();
    const os = fakeOpenSpec({
      issues: [{ level: "INFO", path: "transfers/spec.md", message: REFUSE }],
    });
    await expect(archiveChange(root, ID, { by: "dana", openspec: os })).rejects.toThrow(
      /doesn't pass openspec validate --strict/,
    );
    expect((await changeStore(root).read(ID)).state).toBe("released");
  });

  it("an archive OpenSpec refuses puts the change back as it was, saying OpenSpec's words", async () => {
    const root = await released();
    const os = fakeOpenSpec({
      archive: () => {
        throw new OpenSpecError(
          "transfers: target spec does not exist",
          "change_error",
          ["archive"],
          1,
        );
      },
    });
    const e = await archiveChange(root, ID, { by: "dana", openspec: os }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ChangeError);
    expect((e as ChangeError).message).toContain("OpenSpec refused to archive add-transfer-limit");
    expect((e as ChangeError).reasons[0]!.message).toContain(
      "transfers: target spec does not exist",
    );
    const after = await changeStore(root).read(ID);
    expect(after.state).toBe("released");
    expect(after.history.some((h) => h.to === "archived")).toBe(false);
  });
});
