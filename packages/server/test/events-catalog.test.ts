import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/index.js";

/**
 * beta.23 review: a page reads the catalog's panels again only for a file change that can change
 * the catalog. The server knows where the org pack's layout puts the catalog; the page doesn't,
 * so each file.changed event says whether it is under the catalog or the org pack (`catalog`).
 */
let srv: RunningServer | undefined;
let root: string | undefined;
afterEach(async () => {
  await srv?.close();
  if (root) await rm(root, { recursive: true, force: true });
  srv = root = undefined;
});

it("tags each file change with whether it can change the catalog, following the layout", async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-events-catalog-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeFile(
    join(root, "org-pack", "sources.yaml"),
    "schemaVersion: 2\nlayout:\n  catalog: estate/records\n",
  );
  srv = await startServer({ root, port: 0, watch: false });
  const heard: Record<string, unknown>[] = [];
  srv.events.listen((e) => heard.push(e));
  for (const path of [
    "estate/records/generated/Service/pay.yaml",
    "catalog/generated/Service/pay.yaml",
    "questions/q-1.yaml",
    "org-pack/pack.yaml",
    "estate",
  ])
    srv.events.publish({ type: "file.changed", path });
  srv.events.publish({ type: "job.done", jobId: "j", state: "done" });
  expect(heard.map((e) => e.catalog)).toEqual([true, false, false, true, true, undefined]);
});
