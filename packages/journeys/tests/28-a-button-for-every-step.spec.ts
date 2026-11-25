import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import {
  accessible,
  expect,
  fieldInfo,
  forgeJourney,
  forgeMetarepo,
  forgeStudioMetarepo,
  open,
  startApp,
  stopApp,
  test,
  type App,
} from "../support/app.js";

/**
 * ADR 0188: the app offers a button for every step in the daily path; nobody types a command.
 * A person reads a repo with their own assistant from Map › Trust (Read with my assistant →
 * the prompt → Done), and the map shows it; corrects where a call goes on the canvas, applies it
 * and sees the arrow move; and drafts a change's stories again over stories a person wrote. Each
 * command stays folded under "In a terminal". The assistant's answer is written to the run's
 * folder by the test, as the person's assistant would. Everything is invented (CLAUDE.md rule 3).
 *
 * Beta.30 (slice 9): on the field-shaped estate (fixtures/forge-field), Map › Trust offers a way on
 * for the repo nobody read and the empty one, and a correction is applied from the map's bar among
 * the legacy slot, the hand pairings and the gateway proxies (at the end). Drafting the stories
 * again stays on the tidy estate: the field estate's change is on the quick path, which has no
 * stories stage (ADR 0201), so there is no stage to draft again.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../..");
const STUDIO = join(REPO, "fixtures/forge-studio");
const BIN = join(REPO, "packages/cli/dist/bin.js");

/** A Forge Studio metarepo whose one repo is cloned and not read yet. */
async function unreadStudio(): Promise<{ root: string; head: string }> {
  const parent = await mkdtemp(join(tmpdir(), "atticus-journey-"));
  const env = { ...process.env, ATTICUS_RUNTIME: "hand-off" };
  const init = spawnSync(
    process.execPath,
    [BIN, "init", "forge-studio", "--platform", "forge", "--owner", "priya"],
    { cwd: parent, encoding: "utf8", env },
  );
  if (init.status !== 0) throw new Error(`atticus init failed: ${init.stdout}${init.stderr}`);
  const root = join(parent, "forge-studio");
  const git = (cwd: string, ...a: string[]) =>
    spawnSync(
      "git",
      [
        "-c",
        "user.name=Forge",
        "-c",
        "user.email=forge@example.com",
        "-c",
        "commit.gpgsign=false",
        ...a,
      ],
      { cwd, encoding: "utf8" },
    );
  await writeFile(
    join(root, "org-pack/profiles/forge/repos.manifest.yaml"),
    [
      "schemaVersion: 1",
      "platform: forge",
      "repos:",
      "  - id: forge-studio",
      "    url: https://git.forge.example/forge/forge-studio.git",
      "    type: spring-boot",
      "    owner: team-studio",
      "    system: studio",
      "",
    ].join("\n"),
  );
  const clone = join(root, "workspace/forge-studio");
  await cp(join(STUDIO, "repo"), clone, { recursive: true });
  git(clone, "init", "-q", "-b", "main");
  git(clone, "add", "-A");
  git(clone, "commit", "-qm", "Forge Studio");
  const head = git(clone, "rev-parse", "HEAD").stdout.trim();
  git(root, "config", "user.name", "Priya Nair");
  git(root, "config", "user.email", "priya@forge.example");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "Forge Studio metarepo");
  return { root, head };
}

test.describe("reading a repo from the app, with the person's own assistant", () => {
  test.describe.configure({ mode: "serial" });
  let app: App | undefined;
  let head = "";
  test.beforeAll(async () => {
    const m = await unreadStudio();
    head = m.head;
    app = await startApp(m.root);
  });
  test.afterAll(async () => {
    if (!app) return;
    await stopApp(app);
    await rm(dirname(app.root), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test("prepares the read, takes the answer with Done, and the map shows the repo", async ({
    page,
  }) => {
    const a = app!;
    // An empty catalog offers the page where a repo is read, never a command to type.
    await open(page, a, "canvas");
    await expect(page.locator("main")).not.toContainText("atticus map <repo>");
    await page.getByRole("link", { name: "Read a repo on Map › Read status" }).first().click();
    await expect(page).toHaveURL(/#\/trust/);
    const row = page.getByRole("article", { name: "forge-studio" });
    const read = row.getByRole("button", { name: "Read with my assistant" });
    await expect(read).toBeVisible();
    // The command is there for a terminal, folded.
    await expect(row.locator("details.work-terminal summary").first()).toHaveText("In a terminal");
    await accessible(page, "Map › Read status with a repo to read");
    await read.click();
    const prompt = row.getByRole("link", { name: "Open the prompt and Done" });
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    const runId = /run=([^&]+)/.exec((await prompt.getAttribute("href")) ?? "")![1]!;
    await prompt.click();
    await expect(page).toHaveURL(new RegExp(`run=${runId}`));
    // The person's assistant writes its answer where the prompt says: the facts, each citing
    // its line at the clone's commit.
    const facts = readFileSync(join(STUDIO, "facts/forge-studio.jsonl"), "utf8").replaceAll(
      '"commit":"0000000"',
      `"commit":"${head}"`,
    );
    await writeFile(join(a.root, ".runs/map-forge-studio", runId, "facts.jsonl"), facts);
    await page.getByRole("button", { name: "Done: check the answer" }).click();
    await expect(page.getByText("forge-studio is read and on the map.")).toBeVisible({
      timeout: 90_000,
    });
    // Done put the read on the map (verify --write): the catalog and the canvas have it.
    expect(
      (await readFile(join(a.root, "facts/forge-studio.verify.yaml"), "utf8")).length,
    ).toBeGreaterThan(0);
    await open(page, a, "canvas");
    const outline = page.getByRole("tree");
    await expect(outline.getByRole("treeitem", { name: /system studio/i })).toBeVisible();
    await accessible(page, "the canvas after the read's Done");
    // Trust has the read's facts kept: the repo isn't "not read" any more.
    await open(page, a, "trust");
    await expect(page.getByRole("article", { name: "forge-studio" })).not.toContainText(
      "isn't read yet",
    );
  });
});

test.describe("a correction on the canvas, applied from the app", () => {
  /**
   * The person's pairing on the canvas: the web app's call to POST /api/notes goes to the outside
   * system northwind-notes, not to the api. Written, the map's bar offers its Apply.
   */
  async function correctOnCanvas(page: Page, a: App) {
    await open(page, a, "canvas");
    const outline = page.getByRole("tree");
    // Open the repo's components and pick the web app's box: its links are in the inspector.
    const system = outline.getByRole("treeitem", { name: /system studio/ }).first();
    await expect(system).toBeVisible();
    await system.getByRole("button").first().dblclick();
    const repo = outline.getByRole("treeitem", { name: /forge-studio/ }).first();
    await expect(repo).toBeVisible({ timeout: 30_000 });
    await repo.getByRole("button").first().dblclick();
    const web = outline.getByRole("treeitem", { name: /component web/i }).first();
    await expect(web).toBeVisible({ timeout: 30_000 });
    await web.getByRole("button").first().click();
    await page.locator("summary", { hasText: "Why is web calls api linked?" }).first().click();
    const wrong = page.getByRole("button", { name: /^Say the call web → api.* is wrong$/ });
    await expect(wrong.first()).toBeVisible({ timeout: 30_000 });
    await wrong.first().click();
    const form = page.locator("form.ev-correct").first();
    await form.getByLabel(/It calls an outside system/).check();
    await form.getByRole("textbox").first().fill("northwind-notes");
    await form.getByRole("button", { name: "Write the correction" }).click();
    // Written: Apply first, the commands folded under In a terminal.
    const apply = form.getByRole("button", { name: "Apply to forge-studio's map" });
    await expect(apply).toBeVisible({ timeout: 30_000 });
    // beta.23: the map itself says a correction waits to be applied, with its Apply.
    const bar = page.getByRole("region", { name: "Corrections waiting to be applied" });
    await expect(bar).toContainText("Your corrections aren't in the map yet: forge-studio.");
    await expect(bar.getByRole("button", { name: "Apply to forge-studio's map" })).toBeVisible();
    return { form, apply, bar };
  }

  test("says where a call really goes, Apply redraws the map with no confirm, and the arrow moves", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const a = await startApp(await forgeStudioMetarepo());
    try {
      const { form, apply, bar } = await correctOnCanvas(page, a);
      await accessible(page, "a link corrected on the canvas");
      await apply.click();
      // ADR 0195 point 4 with the reconnect fix (ADR 0204): the arrow the pairing moves counts
      // toward neither limit, so the one other removal (the feature the old call made) is under a
      // tenth of forge-studio's 12 records, and is written with no confirm, as an explained
      // removal under the limits always was.
      await expect(page.getByText("Applied the correction to forge-studio's map.")).toBeVisible({
        timeout: 90_000,
      });
      await expect(form.getByRole("button", { name: /^Review the \d+ removals$/ })).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(bar).toHaveCount(0);
      // The arrow moved: web → northwind-notes is drawn, web → api is gone.
      await open(page, a, "canvas");
      const outline = page.getByRole("tree");
      await expect(outline.getByRole("treeitem", { name: /northwind-notes/i })).toBeVisible({
        timeout: 30_000,
      });
      // The outline keeps the boxes the person opened: open each only if it is closed.
      for (const name of [/system studio/, /forge-studio/]) {
        const item = outline.getByRole("treeitem", { name }).first();
        await expect(item).toBeVisible({ timeout: 30_000 });
        if ((await item.getAttribute("aria-expanded")) !== "true")
          await item.getByRole("button").first().dblclick();
      }
      const web = outline.getByRole("treeitem", { name: /component web/i }).first();
      await expect(web).toBeVisible({ timeout: 30_000 });
      await web.getByRole("button").first().click();
      await expect(
        page.locator("summary", { hasText: "Why is web calls northwind-notes linked?" }).first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.locator("summary", { hasText: "Why is web calls api linked?" }),
      ).toHaveCount(0);
      // The build says what it removed and why: the arrow because its call goes to
      // northwind-notes now, the feature because the person's pairing changed what was read.
      await open(page, a, "catalog-builds");
      const report = page.getByRole("region", { name: "The last build here" });
      await expect(report).toContainText("Written atticus verify forge-studio --write");
      await expect(report).toContainText("2 removed");
      await report.locator("summary", { hasText: "The 2 records it removed, and why" }).click();
      const last = report.getByRole("table", { name: "The records the build would remove" });
      const arrow = last.getByRole("row").filter({ hasText: "Interface/if-" });
      await expect(arrow).toHaveCount(1);
      await expect(arrow).toContainText("its call goes to northwind-notes now");
      const feature = last.getByRole("row").filter({ hasText: "Capability/feature.notes" });
      await expect(feature).toHaveCount(1);
      await expect(feature).toContainText("A pairing changed (facts/*.corrections.jsonl)");
      await expect(feature).toContainText("forge-studio's facts snapshot changed");
      await expect(feature).not.toContainText("its call goes to");
      await expect(last.getByRole("row")).toHaveCount(3);
      // And Home offers Propose for review for it.
      await open(page, a, "home");
      await expect(page.getByRole("button", { name: "Propose for review" }).first()).toBeVisible();
    } finally {
      await stopApp(a);
      await rm(dirname(a.root), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("the same pairing with a removal over the limit is written, not held for a count (ADR 0210 part 3)", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const a = await startApp(await forgeStudioMetarepo());
    try {
      // The person also says the web app's API base setting is wrong (as Map › Facts does):
      // its record goes, and it is no moved arrow, so it counts.
      await open(page, a, "home");
      const token = await page.locator('meta[name="atticus-token"]').getAttribute("content");
      const said = await page.request.post(`${a.url}/api/facts/forge-studio/corrections`, {
        headers: { "X-Atticus-Token": token ?? "" },
        data: {
          fact: "cfg-api-base",
          action: "wrong",
          reason: "the web app reads its base from the gateway",
        },
      });
      expect(said.status(), await said.text()).toBeLessThan(300);
      const { form, apply } = await correctOnCanvas(page, a);
      await apply.click();
      // ADR 0210 part 3 (beta.33): two counted removals (the setting and the feature) are more
      // than a tenth of 12, and Apply no longer waits for their count: it writes them, each
      // listed with what explains it, and one undo takes the write back.
      await expect(page.getByText("Applied the correction to forge-studio's map.")).toBeVisible({
        timeout: 90_000,
      });
      await expect(form.getByRole("button", { name: /^Review the \d+ removals$/ })).toHaveCount(0);
    } finally {
      await stopApp(a);
      await rm(dirname(a.root), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

test.describe("drafting the stories again over a person's stories", () => {
  test.describe.configure({ mode: "serial" });
  // The Forge change at its plan stage, whose stories.md a person wrote (no generated mark).
  const CHANGE = "add-transfer-limit";
  let app: App | undefined;
  test.beforeAll(async () => {
    app = await startApp(await forgeMetarepo());
  });
  test.afterAll(async () => {
    if (app) await stopApp(app);
  });

  test("offers Draft the stories again, and prepares it with the person's yes", async ({
    page,
  }) => {
    await open(page, app!, `stories?change=${CHANGE}`);
    // Beta.27 review: stories a person wrote are the stage's work done by hand: Run next is the
    // plan hand-off, never the stage that would refuse them, and the stage's conversation says
    // who wrote them, with the way on and the way to have the stage write them instead.
    const next = page.locator("section.work-next");
    await expect(next.getByRole("button", { name: "Raise hand-off" })).toBeVisible();
    await expect(next.getByRole("button", { name: "Prepare it for your assistant" })).toHaveCount(
      0,
    );
    const thread = page.getByRole("region", { name: "The stories stage, as one conversation" });
    await expect(thread).toContainText("A person wrote stories.md and tasks.md outside the app");
    await expect(
      thread.getByRole("link", { name: "Go on from them on At a glance" }),
    ).toBeVisible();
    await expect(thread.getByRole("button", { name: "Start the stage" })).toHaveCount(0);
    // Review of the fix: the button names the files it replaces, and asks once.
    const again = thread.getByRole("button", {
      name: "Draft the stories again, replacing stories.md and tasks.md…",
    });
    await expect(again).toBeVisible();
    await accessible(page, "the stories a person wrote, on the Stories page");
    await again.click();
    const ask = thread.getByRole("group", { name: /^This replaces stories\.md and tasks\.md/ });
    await expect(ask).toContainText("stage/stories-by-person/");
    await expect(ask.getByRole("button", { name: "Keep them" })).toBeVisible();
    await accessible(page, "drafting the stories again, asked once");
    await ask.getByRole("button", { name: "Draft the stories again", exact: true }).click();
    await expect(thread.getByRole("link", { name: "Open the prompt and Done" })).toBeVisible({
      timeout: 60_000,
    });
  });
});

test.describe("the field-shaped estate: reading and correcting from the app", () => {
  const field = forgeJourney({ estate: "field" });

  test("Map › Trust names the repo nobody read and the empty one, each with a way on", async ({
    page,
  }) => {
    const info = fieldInfo();
    await open(page, field(), "trust");
    await expect(page.getByText(/Couldn't load this/)).toHaveCount(0);
    for (const repo of [info.unreadRepo!, info.emptyRepo!]) {
      const row = page.getByRole("article", { name: repo });
      await expect(row, repo).toBeVisible();
      // A button forward, the command folded under In a terminal.
      await expect(row.getByRole("button").first(), repo).toBeVisible();
    }
    // A repo read from facts at its clone's commit isn't "not read".
    await expect(page.getByRole("article", { name: info.clones[0]! })).not.toContainText(
      "isn't read yet",
    );
    await accessible(page, "Map › Trust on the field-shaped estate");
  });

  test("a correction is applied from the map's bar, and the map has it", async ({ page }) => {
    test.setTimeout(240_000);
    const a = field();
    const repo = fieldInfo().clones[0]!;
    await open(page, a, "home");
    const token = await page.locator('meta[name="atticus-token"]').getAttribute("content");
    // The person says one of the service's settings is wrong (as Map › Facts does).
    const said = await page.request.post(`${a.url}/api/facts/${repo}/corrections`, {
      headers: { "X-Atticus-Token": token ?? "" },
      data: { fact: "k-0", action: "wrong", reason: "the service reads it from the platform" },
    });
    expect(said.status(), await said.text()).toBeLessThan(300);
    await open(page, a, "canvas");
    const bar = page.getByRole("region", { name: "Corrections waiting to be applied" });
    await expect(bar).toContainText(`Your corrections aren't in the map yet: ${repo}.`);
    await bar.getByRole("button", { name: `Apply to ${repo}'s map` }).click();
    // One setting of a service of a hundred records: under the limits, written with no confirm.
    await expect(page.getByText(`Applied the correction to ${repo}'s map.`)).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(bar).toHaveCount(0);
    await open(page, a, "catalog-builds");
    const report = page.getByRole("region", { name: "The last build here" });
    await expect(report).toContainText(`Written atticus verify ${repo} --write`);
    await expect(report).toContainText("1 removed");
    await accessible(page, "Catalog builds after a correction on the field-shaped estate");
  });
});
