import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { accessible, ask, expect, forgeStudioJourney, open, test } from "../support/app.js";

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

test("Trust filters the repos and reads a trusted repo again from its section (beta.27)", async ({
  page,
}) => {
  await open(page, app(), "trust");
  const filter = page.getByRole("textbox", { name: "Filter the repos" });
  await expect(filter).toBeVisible();
  const section = page.getByRole("region", { name: "Read it again" });
  // A trusted repo, fresh and fully covered, still offers a whole read again.
  await expect(section).toHaveCount(1);
  await expect(
    section.getByText(/Reads forge-studio whole again with your assistant/),
  ).toBeVisible();
  await expect(section.getByRole("button").first()).toBeVisible();
  // The filter keeps the sections whose repo matches, says when none does, and clears.
  await filter.fill("studio");
  await expect(page.getByRole("heading", { name: "forge-studio", level: 3 })).toBeVisible();
  await expect(page.getByText("1 of 1 shown")).toBeVisible();
  await filter.fill("forge-teller");
  await expect(page.getByText("Nothing matches “forge-teller”.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "forge-studio", level: 3 })).toHaveCount(0);
  await accessible(page, "trust filtered to nothing");
  await page.getByRole("button", { name: "Clear the filter" }).click();
  await expect(filter).toBeFocused();
  await expect(page.getByRole("heading", { name: "forge-studio", level: 3 })).toBeVisible();
  await accessible(page, "trust with the repos filter and Read it again");
});

test("Trust shows the canaries, the audit misread and canary pass-through rates, and how to run one (ADR 0196)", async ({
  page,
}) => {
  await open(page, app(), "trust");
  const panel = page.getByRole("region", {
    name: "Canaries and the audit: how often a backed claim is wrong",
  });
  // Nothing scored yet: the commands to run one.
  await expect(panel.getByText(/No canary has been scored yet/)).toBeVisible();
  await expect(panel.getByText("atticus canary plant <repo>")).toBeVisible();
  // A report on file, as atticus canary score writes it.
  const dir = join(app().root, "reports/canaries");
  await mkdir(dir, { recursive: true });
  const rate = (k: number, n: number) =>
    `{ k: ${k}, n: ${n}, rate: ${Math.round((k / n) * 1000) / 1000}, low: 0.1, high: 0.9 }`;
  await writeFile(
    join(dir, "2026-11-11-forge-studio.yaml"),
    [
      "schema: 1",
      "repo: forge-studio",
      "seed: s1",
      "at: 2026-11-11T10:00:00.000Z",
      "by: priya",
      "stacks: [spring]",
      "read: { facts: 12, kept: 11, rejected: 1 }",
      "planted:",
      // a planted item is only its kind, stack and result: no word, file or line of it
      "  - { id: plant:1, kind: entry, what: entry, stack: spring, result: found }",
      "  - { id: plant:2, kind: call, what: call, stack: spring, result: missed }",
      "skipped:",
      "  - { stack: spring, what: topic-in, reason: the build files declare no Kafka client (spring-kafka) }",
      "removed:",
      "  - { id: remove:x, fact: x, kind: call, file: api/src/main/java/forge/studio/A.java, line: 3, claim: call GET /a, value: /a, how: commented, result: rejected, by: x }",
      `recall: ${rate(1, 2)}`,
      `fabrication: ${rate(1, 1)}`,
      `passed: { k: 0, n: 1, rate: 0, low: 0, high: 0.793 }`,
      "",
    ].join("\n"),
  );
  await page.reload();
  // Two numbers side by side, never pooled, named as `atticus canary report` names them.
  await expect(panel.getByText(/^Canary pass-through rate \(.*; 1 repo\):/)).toBeVisible();
  await expect(panel.getByText("0% (0 of 1)").first()).toBeVisible();
  await expect(panel.getByText(/^Audit misread rate \(/)).toBeVisible();
  await expect(panel.getByText(/^The canaries cover spring \(a route, a call\)\./)).toBeVisible();
  await expect(panel.getByRole("table", { name: "The latest canary of each repo" })).toContainText(
    "forge-studio",
  );
  await accessible(page, "trust with a canary on file");
});

test("Home says the assistant the probe measured, and the read, not a scan", async ({ page }) => {
  await open(page, app(), "home");
  const runs = page.getByText("How AI steps run:");
  await expect(runs).toContainText("Claude Code");
  await expect(runs).toContainText("tier 1");
  await expect(runs).not.toContainText("GitHub Copilot");
  // ADR 0191: this metarepo's viewer owns its change as product owner, so set-up is folded away.
  const admin = page.locator("main details > summary", {
    hasText: "Setting up Atticus",
  });
  // One fold for all of set-up (there were three, one of them empty).
  await expect(admin).toHaveCount(1);
  await admin.click();
  const setup = page.getByRole("region", { name: "Set up Atticus" });
  await expect(setup).toContainText("Every repo is read and verified");
  await expect(page.locator("main")).not.toContainText(STALE_SCAN);
  await accessible(page, "home on an Atticus 2 metarepo");
});

test("the Ask box offers the catalog's own words, and a named outside system is searched", async ({
  page,
}) => {
  await open(page, app(), "home");
  // ADR 0194: the title bar's box opens Ctrl+K, which shows the catalog's own example.
  await page.getByRole("button", { name: /^Search the estate, ask, or run a command/ }).click();
  const box = page.getByRole("dialog", { name: "Go to anything" }).getByRole("combobox");
  await expect(box).not.toHaveAttribute("placeholder", /ledger/);
  await expect(box).toHaveAttribute("placeholder", /studio-db\.note/);
  await page.keyboard.press("Escape");
  await ask(page, "what calls the LLM?");
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

test("in an editor's panel (620 to 780 px wide) the activity bar stays beside the page", async ({
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
    // Side by side (ADR 0194): the page starts where the activity bar ends, under the tabs, and
    // takes the rest; the side panel lies over the page on a window this narrow, closed.
    expect(main.x, route).toBeGreaterThanOrEqual(nav.x + nav.width - 1);
    expect(main.y - nav.y, route).toBeLessThan(48);
    expect(main.width, route).toBeGreaterThan(width - nav.width - 24);
    const sideways = await page.evaluate<boolean>(
      "document.documentElement.scrollWidth > document.documentElement.clientWidth",
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

test("a line dragged from a repo and dropped anywhere on another box opens Connect", async ({
  page,
}) => {
  // Tall enough that both boxes are on screen, as a person sees them before dragging (the target
  // box starts about 1,360 px down; Windows' fonts move it further).
  await page.setViewportSize({ width: 1440, height: 2000 });
  await open(page, app(), "canvas");
  const node = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
  // The studio system holds the one repo, forge-studio: a line from it is the repo's.
  const from = node("system:studio").locator(".react-flow__handle.source");
  const to = node("system:llm");
  await expect(from).toBeVisible();
  await expect(to).toBeVisible();
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  // Dropped on the box's body, well away from its small connecting dot (top middle), inside it
  // whatever its size (Windows' fonts draw the boxes at another size).
  await page.mouse.move(b.x + b.width * 0.3, b.y + Math.min(b.height / 2, 60), { steps: 12 });
  await page.mouse.up();
  await expect(
    page.getByRole("heading", { name: /Connect forge-studio to another box/ }),
  ).toBeVisible();
  // The box it was dropped on is picked: the panel never opens with nothing chosen.
  await expect(page.getByLabel("The other box")).toHaveValue("system:llm");
});

test("a line dropped on the inspector connects to no box hidden beneath it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 2000 });
  await open(page, app(), "canvas");
  const from = page.locator(
    '.react-flow__node[data-id="system:studio"] .react-flow__handle.source',
  );
  await expect(from).toBeVisible();
  const aside = page.locator(".viewer-aside");
  await expect(aside).toBeVisible();
  const a = (await from.boundingBox())!;
  const b = (await aside.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + Math.min(b.height / 2, 80), { steps: 12 });
  await page.mouse.up();
  await expect(
    page.getByRole("heading", { name: /Connect forge-studio to another box/ }),
  ).toHaveCount(0);
});
