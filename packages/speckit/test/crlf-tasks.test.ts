import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { markTaskDone, type ChangeTask } from "../src/index.js";

/**
 * Review round 46 (Windows): a tasks.md checked out with CRLF line endings. markTaskDone ticks the
 * task's box and keeps the line's `\r`, rather than matching the line and leaving it unticked.
 */
const CHANGE = "add-transfer-limit";
const TASKS = [
  "# Tasks",
  "",
  "## forge-ledger",
  "",
  "- [ ] 1.1 Refuse over-limit transfers",
  "- [ ] 1.2 Say the limit in the error",
  "",
].join("\r\n");

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const task = (id: string, line: number): ChangeTask => ({
  id,
  repo: "forge-ledger",
  title: "",
  stories: [],
  line,
  done: false,
});

describe("markTaskDone on a CRLF tasks.md", () => {
  it("ticks the box, keeps every line's CRLF, and says so only when it did", async () => {
    root = await mkdtemp(join(tmpdir(), "atticus-crlf-"));
    const dir = join(root, "openspec", "changes", CHANGE);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "tasks.md"), TASKS);
    expect(await markTaskDone(root, CHANGE, task("1.1", 5))).toBe(true);
    const after = await readFile(join(dir, "tasks.md"), "utf8");
    expect(after).toBe(TASKS.replace("- [ ] 1.1", "- [x] 1.1"));
    // ticked already: nothing to do, and it says so
    expect(await markTaskDone(root, CHANGE, task("1.1", 5))).toBe(false);
    expect(await readFile(join(dir, "tasks.md"), "utf8")).toBe(after);
  });
});
