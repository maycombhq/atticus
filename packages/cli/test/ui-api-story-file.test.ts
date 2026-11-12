import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Api } from "@maycombhq/core";
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

/** 3.12.0 (beta.27 review): the Stories tab asked once per story; now one call reads them all. */
it("reads several stories in one call, each as its own read gives it", async () => {
  const { root } = await speckitRoot({ repos: ["forge-ledger"], open: false });
  const dir = join(root, "openspec/changes", CHANGE);
  await mkdir(join(dir, "stories"), { recursive: true });
  await writeFile(join(dir, "stories.md"), "# Stories\n");
  await writeFile(join(dir, "stories/s1-cap.md"), "# Cap transfers\n");
  await writeFile(join(dir, "stories/s2-limit.md"), "# Daily limit\n");
  const s = await startServer({ root, port: 0, user: "pat", extend: (r, ctx) => uiRoutes(r, ctx) });
  try {
    const h = { "X-Atticus-Token": s.token };
    const base = `${s.url}/api/changes/${CHANGE}/artifacts/stories`;
    const files = ["stories/s1-cap.md", "stories/s2-limit.md"];
    const one = await Promise.all(
      files.map(async (f) => {
        const r = await fetch(`${base}?file=${encodeURIComponent(f)}`, { headers: h });
        return (await r.json()) as Record<string, unknown>;
      }),
    );
    const q = files.map((f) => `file=${encodeURIComponent(f)}`).join("&");
    const r = await fetch(`${base}/files?${q}`, { headers: h });
    expect(r.status).toBe(200);
    const got = Api.ArtifactFiles.parse(await r.json());
    expect(got.files).toEqual(files.map((file, i) => ({ file, ...one[i] })));
    expect(got.problems).toEqual({});
    // No file named: refused. One the artifact doesn't have is its own problem, as its one-file
    // read answers it (beta.27 re-review: the call no longer fails whole).
    expect((await fetch(`${base}/files`, { headers: h })).status).toBe(400);
    const bad = await fetch(`${base}/files?file=${encodeURIComponent("../brief.md")}`, {
      headers: h,
    });
    expect(bad.status).toBe(200);
    expect(Api.ArtifactFiles.parse(await bad.json()).problems?.["../brief.md"]).toMatchObject({
      status: 404,
    });
    // An artifact that isn't one: the call is refused whole.
    expect(
      (await fetch(`${s.url}/api/changes/${CHANGE}/artifacts/nope/files?file=a.md`, { headers: h }))
        .status,
    ).toBe(400);
  } finally {
    await s.close();
  }
}, 60_000);

/** Beta.27 re-review: one story deleted since the page listed it failed the whole batch (404). */
it("a story deleted since it was listed is its own problem; the others are answered", async () => {
  const { root } = await speckitRoot({ repos: ["forge-ledger"], open: false });
  const dir = join(root, "openspec/changes", CHANGE);
  await mkdir(join(dir, "stories"), { recursive: true });
  await writeFile(join(dir, "stories.md"), "# Stories\n");
  await writeFile(join(dir, "stories/s1-cap.md"), "# Cap transfers\n");
  await writeFile(join(dir, "stories/s2-limit.md"), "# Daily limit\n");
  await writeFile(join(dir, "stories/s3-gone.md"), "# Deleted soon\n");
  const s = await startServer({ root, port: 0, user: "pat", extend: (r, ctx) => uiRoutes(r, ctx) });
  try {
    const h = { "X-Atticus-Token": s.token };
    const base = `${s.url}/api/changes/${CHANGE}/artifacts/stories`;
    await rm(join(dir, "stories/s3-gone.md"));
    const files = ["stories/s1-cap.md", "stories/s3-gone.md", "stories/s2-limit.md"];
    const q = files.map((f) => `file=${encodeURIComponent(f)}`).join("&");
    const r = await fetch(`${base}/files?${q}`, { headers: h });
    expect(r.status).toBe(200);
    const got = Api.ArtifactFiles.parse(await r.json());
    expect(got.files.map((f) => [f.file, f.content])).toEqual([
      ["stories/s1-cap.md", "# Cap transfers\n"],
      ["stories/s2-limit.md", "# Daily limit\n"],
    ]);
    expect(got.problems?.["stories/s3-gone.md"]).toMatchObject({ status: 404 });
  } finally {
    await s.close();
  }
}, 60_000);

/**
 * Beta.27 re-review (plumbing): a file listed but gone when it is read (deleted between the two:
 * here a link to nothing, which the listing sees and a read can't open) is that file's 404, never
 * an empty story nor a 500 for the call.
 */
it.skipIf(process.platform === "win32")(
  "a file gone between the listing and its read is that file's 404",
  async () => {
    const { root } = await speckitRoot({ repos: ["forge-ledger"], open: false });
    const dir = join(root, "openspec/changes", CHANGE);
    await mkdir(join(dir, "stories"), { recursive: true });
    await writeFile(join(dir, "stories.md"), "# Stories\n");
    await writeFile(join(dir, "stories/s1-cap.md"), "# Cap transfers\n");
    await symlink(join(dir, "stories/nowhere.md"), join(dir, "stories/s2-racing.md"));
    const s = await startServer({
      root,
      port: 0,
      user: "pat",
      extend: (r, ctx) => uiRoutes(r, ctx),
    });
    try {
      const h = { "X-Atticus-Token": s.token };
      const base = `${s.url}/api/changes/${CHANGE}/artifacts/stories`;
      const files = ["stories/s1-cap.md", "stories/s2-racing.md"];
      const q = files.map((f) => `file=${encodeURIComponent(f)}`).join("&");
      const r = await fetch(`${base}/files?${q}`, { headers: h });
      expect(r.status).toBe(200);
      const got = Api.ArtifactFiles.parse(await r.json());
      expect(got.files.map((f) => f.file)).toEqual(["stories/s1-cap.md"]);
      expect(got.problems?.["stories/s2-racing.md"]).toMatchObject({ status: 404 });
    } finally {
      await s.close();
    }
  },
  60_000,
);
