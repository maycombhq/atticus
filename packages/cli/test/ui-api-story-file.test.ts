import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startServer } from "@maycombhq/server";
import { uiRoutes } from "../src/ui-api.js";
import { CHANGE, speckitRoot } from "./run-helpers.js";

/**
 * Seventh UX walk: a story is read and edited alone (`?file=stories/<id>.md`), so the Stories
 * tab shows each story's text with Edit; only a file the artifact has, never a path elsewhere.
 */
it("reads and saves one story by its file, and refuses a file the artifact doesn't have", async () => {
  const { root } = await speckitRoot({ repos: ["forge-ledger"], open: false });
  const dir = join(root, "openspec/changes", CHANGE);
  await mkdir(join(dir, "stories"), { recursive: true });
  await writeFile(join(dir, "stories.md"), "# Stories\n");
  await writeFile(join(dir, "stories/s1-cap.md"), "# Cap transfers\n");
  const s = await startServer({ root, port: 0, user: "pat", extend: (r, ctx) => uiRoutes(r, ctx) });
  try {
    const h = { "X-Atticus-Token": s.token, "Content-Type": "application/json" };
    const base = `${s.url}/api/changes/${CHANGE}/artifacts/stories`;
    const index = (await (await fetch(base, { headers: h })).json()) as { path: string };
    expect(index.path).toMatch(/stories\.md$/);
    const url = `${base}?file=${encodeURIComponent("stories/s1-cap.md")}`;
    const got = (await (await fetch(url, { headers: h })).json()) as {
      path: string;
      content: string;
      sha256: string;
    };
    expect(got.path).toMatch(/stories\/s1-cap\.md$/);
    expect(got.content).toBe("# Cap transfers\n");
    const put = await fetch(url, {
      method: "PUT",
      headers: h,
      body: JSON.stringify({ content: "# Cap daily transfers\n", baseSha256: got.sha256 }),
    });
    expect(put.status, await put.clone().text()).toBe(200);
    expect(await readFile(join(dir, "stories/s1-cap.md"), "utf8")).toBe("# Cap daily transfers\n");
    expect(await readFile(join(dir, "stories.md"), "utf8")).toBe("# Stories\n");
    for (const bad of ["../brief.md", "brief.md", "stories/s9-none.md"]) {
      const r = await fetch(`${base}?file=${encodeURIComponent(bad)}`, { headers: h });
      expect(r.status, bad).toBe(404);
    }
  } finally {
    await s.close();
  }
}, 60_000);
