import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTerminalRunLines, startTerminalRun, withPrinter } from "@maycombhq/core";
import { printProgress, withRunLine } from "../src/run-progress.js";

/**
 * ADR 0187 (review): a Copilot ACP step's progress goes where the run's other lines go: the
 * terminal (standard error), the command's run log for the Console, and the app job's lines.
 */

describe("a Copilot step's progress", () => {
  it("lands in the terminal, the run's log and the app job's lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-progress-"));
    await mkdir(join(root, "org-pack"));
    const rec = startTerminalRun(root, {
      positionals: ["map", "forge-ledger"],
      flags: [],
      pid: 9,
    })!;
    const stderr: string[] = [];
    const job: string[] = [];
    const write = (s: string) => void stderr.push(s);
    await withRunLine(
      (l) => rec.line(l),
      () =>
        withPrinter(
          (l) => job.push(l),
          async () => {
            await new Promise((r) => setTimeout(r, 1));
            printProgress("copilot: reading forge-ledger/src/app.ts", write);
          },
        ),
    );
    expect(stderr).toEqual(["copilot: reading forge-ledger/src/app.ts\n"]);
    expect(job).toEqual(["copilot: reading forge-ledger/src/app.ts"]);
    expect(readTerminalRunLines(root, rec.runId)!.lines).toEqual([
      "copilot: reading forge-ledger/src/app.ts",
    ]);
    // Outside a run: the terminal only.
    printProgress("copilot: done", write);
    expect(stderr.at(-1)).toBe("copilot: done\n");
    expect(readTerminalRunLines(root, rec.runId)!.lines).toHaveLength(1);
  });
});
