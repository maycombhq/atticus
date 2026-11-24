import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { buildAndWrite } from "@maycombhq/scanner";
import { makeFieldEstate } from "./field-estate.js";
import { timeOneBuild, timingLines } from "../src/selfcheck-timing.js";

it("times", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zz-"));
  const e = await makeFieldEstate(dir);
  await buildAndWrite(e.root, { command: "atticus catalog build" });
  console.log("ROOT", e.root);
  const t = await timeOneBuild(e.root);
  writeFileSync("/tmp/zz-timing.txt", [e.root, ...timingLines(t, 40)].join("\n"));
}, 1_200_000);
