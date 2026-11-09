import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  accessible,
  expect,
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
    await page.getByRole("link", { name: "Read a repo on Map › Trust" }).first().click();
    await expect(page).toHaveURL(/#\/trust/);
    const row = page.getByRole("article", { name: "forge-studio" });
    const read = row.getByRole("button", { name: "Read with my assistant" });
    await expect(read).toBeVisible();
    // The command is there for a terminal, folded.
    await expect(row.locator("details.work-terminal summary").first()).toHaveText("In a terminal");
    await accessible(page, "Map › Trust with a repo to read");
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
  test.describe.configure({ mode: "serial" });
  let app: App | undefined;
  test.beforeAll(async () => {
    app = await startApp(await forgeStudioMetarepo());
  });
  test.afterAll(async () => {
    if (!app) return;
    await stopApp(app);
    await rm(dirname(app.root), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test("says where a call really goes, Apply redraws the map, and the arrow moves", async ({
    page,
  }) => {
    const a = app!;
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
    await accessible(page, "a link corrected on the canvas");
    await apply.click();
    // Apply can take the form away (the link it was on moves): what happened stays on the page,
    // with where to propose it.
    await expect(page.getByText("Applied the correction to forge-studio's map.")).toBeVisible({
      timeout: 90_000,
    });
    // The arrow moved: the web app's call goes to the outside system now, not to the api.
    await open(page, a, "canvas");
    await expect(
      page.getByRole("tree").getByRole("treeitem", { name: /northwind-notes/i }),
    ).toBeVisible({ timeout: 30_000 });
    // And Home offers Propose for review for it.
    await open(page, a, "home");
    await expect(page.getByRole("button", { name: "Propose for review" }).first()).toBeVisible();
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
    const next = page.locator("section.work-next");
    await next.getByRole("button", { name: "Prepare it for your assistant" }).click();
    await expect(next.getByRole("alert").first()).toContainText("a person wrote", {
      timeout: 60_000,
    });
    await expect(next.getByRole("alert").first()).not.toContainText("--force");
    const again = next.getByRole("button", { name: "Draft the stories again" });
    await expect(again).toBeVisible();
    await accessible(page, "the stories refused over a person's stories");
    await again.click();
    await expect(next.getByRole("link", { name: "Open the prompt and Done" })).toBeVisible({
      timeout: 60_000,
    });
  });
});
