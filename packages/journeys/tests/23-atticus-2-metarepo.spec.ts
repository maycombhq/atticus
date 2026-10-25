import type { Page } from "@playwright/test";
import { accessible, expect, forgeStudioJourney, open, test } from "../support/app.js";

/**
 * A metarepo made the Atticus 2 way (fixtures/forge-studio): one repo read by the assistant and
 * verified, its facts file beside its companions (questions, reviewed, the verifier's report), a
 * manifest that names the repo's system, a call to an outside system (a model provider, `llm`),
 * a web component whose call the join follows into the API's flow, a probe that measured Claude
 * Code, and a change whose stages ran through stories and which waits on its hand-off gate. The
 * small Forge fixtures the other journeys use missed each thing below. Everything is invented
 * (CLAUDE.md rule 3).
 */
const app = forgeStudioJourney();
const CHANGE = "add-note-tags";

/** The Atticus 1 read, as guidance: `atticus scan` and its steps (the knowledge scan is another). */
const STALE_SCAN = /atticus scan(?! *--source)\b|scan again|first scan/i;

const runNext = (page: Page) => page.getByRole("region", { name: "Run next" });

test("Trust counts the repo once: the facts file's companions aren't repos", async ({ page }) => {
  await open(page, app(), "trust");
  await expect(page.getByText("1 of 1 repos trusted")).toBeVisible();
  await expect(page.getByText(/doesn't read as facts/)).toHaveCount(0);
  await expect(page.getByText(/forge-studio\.(questions|reviewed)/i)).toHaveCount(0);
  await accessible(page, "trust on an Atticus 2 metarepo");
});

test("Home says the assistant the probe measured, and the read, not a scan", async ({ page }) => {
  await open(page, app(), "home");
  const runs = page.getByText("How AI steps run:");
  await expect(runs).toContainText("Claude Code");
  await expect(runs).toContainText("tier 1");
  await expect(runs).not.toContainText("GitHub Copilot");
  const setup = page.getByRole("region", { name: "Set up Atticus" });
  await expect(setup).toContainText("Every repo is read and verified");
  await expect(page.locator("main")).not.toContainText(STALE_SCAN);
  await accessible(page, "home on an Atticus 2 metarepo");
});

test("the Ask box offers the catalog's own words, and a named outside system is searched", async ({
  page,
}) => {
  await open(page, app(), "home");
  const ask = page.getByLabel("Ask Atticus");
  await expect(ask).not.toHaveAttribute("placeholder", /ledger/);
  await expect(ask).toHaveAttribute("placeholder", /studio-db\.note/);
  await ask.fill("what calls the LLM?");
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(page.getByText("kind:interface to:llm").first()).toBeVisible();
  await expect(page.getByText("api → llm POST /v1/messages").first()).toBeVisible();
  await expect(page.getByText("web → api POST /api/notes")).toHaveCount(0);
  await accessible(page, "ask on an Atticus 2 metarepo");
});

test("the Map draws the manifest's system and the outside system the facts call", async ({
  page,
}) => {
  await open(page, app(), "canvas");
  const outline = page.getByRole("tree");
  await expect(outline.getByRole("treeitem", { name: /system studio/i })).toBeVisible();
  await expect(outline.getByRole("treeitem", { name: /system llm/i })).toBeVisible();
  await expect(page.locator("main")).not.toContainText(STALE_SCAN);
  await accessible(page, "estate canvas on an Atticus 2 metarepo");

  await open(page, app(), "map");
  const systems = page.getByRole("region", { name: "Systems" });
  await expect(systems).toContainText("studio");
  await expect(systems).toContainText("llm");
  await expect(page.getByText("No systems yet.")).toHaveCount(0);
  const knows = page.getByRole("region", { name: "What the catalog knows" });
  // No System record: what the facts say, by repo.
  await expect(knows.getByRole("row", { name: /forge-studio/ })).toContainText("3");
  await expect(knows).toContainText("Entries");
  await expect(knows).toContainText("Flows");
  await accessible(page, "ecosystem map on an Atticus 2 metarepo");
});

test("a flow's caller is the flow the join says calls it", async ({ page }) => {
  await open(page, app(), "flows?repo=forge-studio&flow=api.create-a-note");
  await expect(page.getByText("Called by:")).toContainText("Write a note");
  await expect(page.getByText("Caller not known")).toHaveCount(0);
  await expect(page.getByText("Who calls this entry point isn't known yet.")).toHaveCount(0);
  await expect(page.locator(".seq-lane.caller").first()).toContainText("Write a note");
  await accessible(page, "flow with a joined caller");
});

test("a stage tab's Run next follows its own stage and the gate", async ({ page }) => {
  await open(page, app(), `stories?change=${CHANGE}`);
  await expect(runNext(page)).not.toContainText("at the feature stage");
  await expect(runNext(page)).toContainText("The stories stage is done");
  await expect(runNext(page)).toContainText(`atticus change handoff ${CHANGE} --approve`);
  await accessible(page, "stories tab waiting on its gate");

  await open(page, app(), `architecture?change=${CHANGE}`);
  await expect(runNext(page)).toContainText("The architecture stage is done");
  await expect(page.locator("main")).not.toContainText(STALE_SCAN);
  await accessible(page, "architecture tab waiting on its gate");
});

test("All changes shows the stage artifacts, and the OpenSpec-era ones only when there", async ({
  page,
}) => {
  await open(page, app(), `changes/${CHANGE}`);
  const table = page.getByRole("table").filter({ hasText: "stories" }).first();
  const names = await table.locator("tbody td.mono").allInnerTexts();
  // The stages' artifacts first (the architecture stage wrote design.md), then the brief.
  expect(names).toEqual(["design", "stories", "tasks", "brief"]);
  for (const old of ["proposal", "specs", "interfaces", "mappings", "data", "ux", "snow"])
    expect(names, `${old} isn't shown: the change has no ${old} file`).not.toContain(old);
  await accessible(page, "all changes on an Atticus 2 change");
});

test("in an editor's panel (620 to 780 px wide) the menu stays beside the page", async ({
  page,
}) => {
  // VS Code's panel was about 780 px, less its scroll bar: the menu stacked above the page.
  for (const [width, route] of [
    [780, "home"],
    [760, "trust"],
    [700, `stories?change=${CHANGE}`],
    [620, "canvas"],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await open(page, app(), route);
    const nav = (await page.getByRole("navigation", { name: "Main" }).boundingBox())!;
    const main = (await page.locator("main").boundingBox())!;
    // Side by side: the page starts where the menu ends, at the top, and takes the rest.
    expect(main.x, route).toBeGreaterThanOrEqual(nav.x + nav.width - 1);
    expect(Math.abs(main.y - nav.y), route).toBeLessThan(2);
    expect(main.width, route).toBeGreaterThan(width - nav.width - 24);
    const sideways = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(sideways, `${route} scrolls sideways`).toBe(false);
  }
  await accessible(page, "the canvas at 620 px");
});

test("the tour, once skipped, stays closed for this metarepo", async ({ page, context }) => {
  const a = app();
  await page.goto(`${a.url}/#/home`);
  const tour = page.getByRole("dialog", { name: "Your home" });
  await expect(tour).toBeVisible();
  await page.getByRole("button", { name: "Skip the tour" }).click();
  await expect(tour).toHaveCount(0);
  for (const route of ["trust", "canvas", `stories?change=${CHANGE}`]) {
    await page.goto(`${a.url}/#/${route}`);
    await page.reload();
    await expect(page.locator(".panel").first()).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  const other = await context.newPage();
  await other.goto(`${a.url}/#/home`);
  await expect(other.locator(".panel").first()).toBeVisible();
  await expect(other.getByRole("dialog")).toHaveCount(0);
});

test("the tour left open closes when the person moves to another page", async ({ browser }) => {
  const a = app();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${a.url}/#/home`);
  await expect(page.getByRole("dialog", { name: "Your home" })).toBeVisible();
  await page.goto(`${a.url}/#/trust`);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".panel").first()).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await context.close();
});
