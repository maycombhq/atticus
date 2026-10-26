/**
 * Feature detection (ADR 0006 addendum, "Compatibility"): what the pinned OpenSpec offers, read
 * from its own help, and a store read through `openspec list` with the file reading as fallback.
 * The real, pinned CLI, offline.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BETA_FEATURES,
  commandsIn,
  createOpenSpec,
  openspecFeatures,
  readStoreVia,
} from "../src/index.js";

const T = 60_000;

describe("OpenSpec's features, from its help", () => {
  it("reads command names under Commands:", () => {
    expect(
      commandsIn(
        "Usage: x\n\nCommands:\n  setup [options] [id]  Create\n  list|ls [options]     List\n                        more words\n  doctor [id]          Check\n",
      ),
    ).toEqual(["setup", "list", "doctor"]);
    expect(commandsIn("Usage: x\n")).toEqual([]);
  });

  it(
    "finds every beta feature of the pinned 1.14.0, and which print JSON",
    async () => {
      const f = await openspecFeatures();
      for (const b of BETA_FEATURES) expect(f.beta[b].present, b).toBe(true);
      expect(f.beta.context.json).toBe(true);
      expect(f.beta.doctor.json).toBe(true);
      expect(f.commands).toEqual(expect.arrayContaining(["status", "instructions", "validate"]));
      // cached per CLI script
      expect(await openspecFeatures()).toBe(f);
    },
    T,
  );
});

describe("a store read through OpenSpec", () => {
  it(
    "lists its open changes with task counts and its specs with openspec list, and says so",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "atticus-store-via-"));
      await createOpenSpec({ root: dir }).init();
      const c = join(dir, "openspec/changes/add-limit");
      await mkdir(c, { recursive: true });
      await writeFile(
        join(c, "proposal.md"),
        "# Add a limit\n\n## Why\n\nNorthwind Pay asks for it.\n",
      );
      await writeFile(join(c, "tasks.md"), "## ledger\n\n- [x] 1.1 One\n- [ ] 1.2 Two\n");
      const s = join(dir, "openspec/specs/transfers");
      await mkdir(s, { recursive: true });
      await writeFile(
        join(s, "spec.md"),
        "# transfers\n\n## Purpose\n\nMoving money between accounts, with limits.\n\n## Requirements\n\n### Requirement: Limit\nThe system SHALL refuse a transfer over the limit.\n\n#### Scenario: Over\n- **WHEN** over\n- **THEN** refused\n",
      );
      const v = await readStoreVia(dir);
      expect(v.via).toBe("openspec");
      expect(v.changes.map((x) => [x.id, x.tasks])).toEqual([["add-limit", { done: 1, total: 2 }]]);
      expect(v.specs.map((x) => [x.id, x.purpose])).toEqual([
        ["transfers", "Moving money between accounts, with limits."],
      ]);
    },
    T,
  );

  it(
    "falls back to its files where OpenSpec can't run there, and says so",
    async () => {
      const v = await readStoreVia(join(tmpdir(), "atticus-no-such-store"));
      expect(v.via).toBe("files");
      expect(v.notes.join("\n")).toContain("isn't there");
    },
    T,
  );
});
