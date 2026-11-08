import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { defaultOnPath } from "../src/doctor.js";

/** Review round 32: a quoted PATH entry is read without its quotes, as Windows does. */
it("finds a program on a quoted PATH entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "doctor-path-"));
  await writeFile(join(dir, "copilot.cmd"), "");
  const onPath = defaultOnPath({ PATH: `C:\\Windows; "${dir}" `, PATHEXT: ".EXE;.CMD" }, "win32");
  expect(onPath("copilot")).toBe(true);
  expect(onPath("claude")).toBe(false);
});
