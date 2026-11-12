import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import {
  accessible,
  atticus,
  catalogFiles,
  expect,
  open,
  startApp,
  stopApp,
  test,
  type App,
} from "../support/app.js";

/**
 * ADR 0195 (ticket CS3): the readers' cross-check and the build's confirm steps, in the app. The
 * metarepo is the Forge estate built from its golden slots (every repo's readers slot, the
 * ledger's facts snapshot) with `atticus catalog build`, as a team has it after beta.27's
 * upgrade. A person reads what the readers found beside the facts, dismisses one (its command in
 * the Console), promotes another to their own fact (shown first, then verify), and both pages
 * fit VS Code's panel without scrolling sideways; then a scan-like read that lost most of a
 * repo's records is refused in a terminal (its report is the page's last build), waits for its
 * count, is confirmed, and is undone; a hand edit is made curated; and a catalog from before
 * beta.27 is upgraded from the app, every file it writes listed and confirmed with their count.
 * Everything is the invented Forge estate (CLAUDE.md rule 3).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../../fixtures");
const SHOTS = process.env.ATTICUS_SHOTS;

async function slotsMetarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-journey-cs3-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  await cp(join(FIXTURES, "forge/slots/readers"), join(root, "catalog/sources/readers"), {
    recursive: true,
  });
  await cp(join(FIXTURES, "forge/slots/facts"), join(root, "catalog/sources/facts"), {
    recursive: true,
  });
  await mkdir(join(root, "facts"), { recursive: true });
  const built = atticus(root, "catalog", "build");
  if (!existsSync(join(root, "catalog/sources/build.json")))
    throw new Error(`atticus catalog build didn't build: ${built}`);
  const git = (...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Priya Nair");
  git("config", "user.email", "priya@forge.example");
  git("add", "-A");
  git("commit", "-qm", "Forge metarepo, built from its slots");
  return root;
}

let app: App | undefined;
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  app = await startApp(await slotsMetarepo());
});
test.afterAll(async () => {
  if (app) await stopApp(app);
});
const a = () => app!;

const sideways = (page: Page) =>
  page.evaluate<boolean>(
    "document.documentElement.scrollWidth > document.documentElement.clientWidth",
  );
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `cs3-${name}.png`), fullPage: false });
};
/** As VS Code's panel and IntelliJ's tool window load the app (ADR 0194 point 4). */
async function embedded(page: Page, route: string, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${a().url}/?host=intellij#/${route}`);
  await expect(page.locator(".panel").first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  const skip = page.getByRole("button", { name: "Skip the tour" });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

test.use({ deviceScaleFactor: 2 });

test("reads what the readers found beside the facts, and dismisses one", async ({ page }) => {
  await open(page, a(), "trust");
  await page.getByRole("link", { name: "Readers found / facts say" }).first().click();
  await expect(page).toHaveURL(/#\/crosscheck/);
  await expect(
    page.getByRole("heading", { level: 2, name: "Readers found / facts say" }),
  ).toBeVisible();
  await expect(page.getByLabel("Repo")).toHaveValue("forge-ledger");
  const list = page.getByRole("list", { name: "Cross-check items of forge-ledger" });
  await expect(list).toBeVisible();
  await expect(list.getByText("api/ledger-openapi.yaml:6")).toBeVisible();
  await accessible(page, "Readers found / facts say, dark");
  await shot(page, "crosscheck-1440-dark");

  // The filter is a group of radios: the arrow keys move between them.
  const found = page.getByRole("radio", { name: /^Readers found \(\d+\)$/ });
  await expect(found).toBeChecked();
  await found.focus();
  await page.keyboard.press("ArrowRight");
  const disagree = page.getByRole("radio", { name: "Disagree (2)" });
  await expect(disagree).toBeChecked();
  await expect(page).toHaveURL(/show=disagree/);
  await expect(list.getByText("forge-service")).toBeVisible();

  const before = catalogFiles(a().root);
  await page.getByRole("button", { name: "Dismiss Component|ledger-api" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Dismissed Component|ledger-api." }),
  ).toBeVisible();
  await expect(page.getByRole("radio", { name: "Dismissed (1)" })).toBeVisible();
  expect(readFileSync(join(a().root, "facts/forge-ledger.crosscheck.yaml"), "utf8")).toContain(
    "key: Component|ledger-api",
  );
  // Nothing in the catalog changed.
  expect(catalogFiles(a().root)).toEqual(before);
  // Its command is in the Console, with what it printed (ADR 0187).
  await page.getByRole("button", { name: "Show in the Console" }).click();
  const log = page.getByRole("log", { name: "Dismiss on forge-ledger" });
  await expect(log).toContainText("dismissed Component|ledger-api");
  await accessible(page, "the cross-check with the Console open");
});

test("promotes what the readers found to the person's own fact, shown first", async ({ page }) => {
  await open(page, a(), "crosscheck?repo=forge-ledger");
  const key = "Endpoint|GET /accounts/{}/balance";
  await page.getByRole("button", { name: `Promote ${key} to your own fact` }).click();
  const dialog = page.getByRole("dialog", { name: "Promote to your own fact" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("Cites src/main/java/forge/ledger/LedgerEndpoints.java:8 at commit aaaaaaa"),
  ).toBeVisible();
  await expect(
    dialog.getByText("It claims /accounts/{id}/balance is written on that line."),
  ).toBeVisible();
  await expect(dialog.getByText("facts/forge-ledger.jsonl isn't here")).toBeVisible();
  await accessible(page, "promote's confirm");
  await shot(page, "promote-1440-dark");
  const before = catalogFiles(a().root);
  await dialog.getByRole("button", { name: "Write it, then verify" }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  // This metarepo has no base clone of the ledger, so verify can't check the line yet: the fact
  // is written, and the item says it isn't verified yet (and why the step stopped).
  const item = page.locator("li.xc-item", { hasText: "GET /accounts/{}/balance" });
  await expect(item.getByText("Your fact: not verified yet")).toBeVisible();
  await expect(item.getByRole("alert")).toContainText("Your fact is written; verify stopped");
  const facts = readFileSync(join(a().root, "facts/forge-ledger.jsonl"), "utf8");
  expect(facts).toContain('"by":"person"');
  expect(facts).toContain('"line":8');
  // Nothing in the catalog changed: verify --write (Apply) does that.
  expect(catalogFiles(a().root)).toEqual(before);
  await accessible(page, "a promoted item");
  await shot(page, "promoted-1440-dark");
  await page.getByRole("button", { name: "Show in the Console" }).click();
  await expect(
    page.getByRole("log", {
      name: "Promote on forge-ledger",
    }),
  ).toContainText("promoted");
});

test("fits VS Code's panel at 780 and 420 px without scrolling sideways", async ({ page }) => {
  for (const width of [780, 420]) {
    for (const route of ["crosscheck?repo=forge-ledger", "catalog-builds"]) {
      await embedded(page, route, width);
      expect(await sideways(page), `${route} at ${width} px scrolls sideways`).toBe(false);
      if (width === 780) await shot(page, `${route.split("?")[0]}-780-embedded`);
    }
    await accessible(page, `Catalog builds at ${width} px`);
  }
});

test("a large removal waits for its count, is confirmed, then undone", async ({ page }) => {
  // The gateway's next read finds one record where it found many (a reader that stopped short).
  const slot = join(a().root, "catalog/sources/readers/forge-gateway.json");
  const s = JSON.parse(readFileSync(slot, "utf8")) as { records: unknown[] };
  const was = readFileSync(slot, "utf8");
  writeFileSync(slot, JSON.stringify({ ...s, records: s.records.slice(0, 1) }, null, 2) + "\n");
  const before = catalogFiles(a().root);
  // Someone builds in a terminal first: it refuses, and its report is the page's last build.
  expect(atticus(a().root, "catalog", "build")).toMatch(/--allow-removals \d+/);
  await open(page, a(), "scans");
  await page.getByRole("link", { name: "Catalog builds: confirm, undo, prune" }).click();
  await expect(page).toHaveURL(/#\/catalog-builds$/);
  await expect(page.getByText("The build waits for you: nothing has been written.")).toBeVisible();
  const review = page.getByRole("button", { name: /^Review the \d+ removals$/ });
  const n = Number(/\d+/.exec((await review.textContent()) ?? "")![0]);
  const last = page.locator(".panel", {
    has: page.getByRole("heading", { name: "The last build here" }),
  });
  await expect(last.getByText("Refused: nothing written")).toBeVisible();
  await expect(last.getByText(`The ${n} records it would have removed, and why`)).toBeVisible();
  await expect(last.getByText(`atticus catalog build --allow-removals ${n}`).first()).toBeVisible();
  await accessible(page, "a terminal's refused build");
  await last.scrollIntoViewIfNeeded();
  await shot(page, "last-build-refused-1440-dark");
  await review.click();
  const dialog = page.getByRole("dialog", { name: `Confirm ${n} removals` });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("table", { name: "The records the build would remove" }),
  ).toBeVisible();
  await accessible(page, "the removals' confirm");
  await shot(page, "confirm-removals-1440-dark");
  const remove = dialog.getByRole("button", { name: `Remove ${n} records` });
  await expect(remove).toBeDisabled();
  await dialog.getByLabel(`Type ${n} to confirm exactly these`).fill(String(n + 1));
  await expect(remove).toBeDisabled();
  expect(catalogFiles(a().root)).toEqual(before);
  await dialog.getByLabel(`Type ${n} to confirm exactly these`).fill(String(n));
  await remove.click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  await expect(page.getByText("Done. What it printed is in the Console.")).toBeVisible();
  await expect(
    page.getByText("catalog/generated is what the slots and inputs build."),
  ).toBeVisible();
  const after = catalogFiles(a().root);
  expect(Object.keys(after).length).toBeLessThan(Object.keys(before).length);
  // The app's build is now the last one: written, its removals each with why.
  await expect(last.getByText("Written", { exact: true })).toBeVisible();
  await expect(last.getByText(`The ${n} records it removed, and why`)).toBeVisible();

  // Undo the build: the files it puts back are listed first.
  await page.getByRole("button", { name: "Undo the latest build" }).first().click();
  const undo = page.getByRole("dialog", { name: "Undo the latest build" });
  await expect(undo.getByRole("list", { name: "The files undo puts back" })).toBeVisible();
  await accessible(page, "the undo's confirm");
  await undo.getByRole("button", { name: /^Put back \d+ files?$/ }).click();
  await expect(undo).toBeHidden({ timeout: 60_000 });
  expect(catalogFiles(a().root)).toEqual(before);
  // The slot was written by hand here, not by a command, so undo leaves it: put it back, and the
  // build has nothing waiting.
  writeFileSync(slot, was);
  await page.reload();
  await expect(
    page.getByText("catalog/generated is what the slots and inputs build."),
  ).toBeVisible();
  await shot(page, "catalog-builds-1440-dark");
});

test("a hand edit is never overwritten: it is made curated", async ({ page }) => {
  const files = Object.keys(catalogFiles(a().root)).filter((f) => f.startsWith("table/"));
  const path = join(a().root, "catalog/generated", files[0]!);
  writeFileSync(path, readFileSync(path, "utf8").replace(/^name: (.+)$/m, "name: $1-by-hand"));
  await open(page, a(), "catalog-builds");
  await expect(page.getByText(`changed: catalog/generated/${files[0]}`)).toBeVisible();
  await accessible(page, "a hand edit listed");
  await page.getByRole("button", { name: "Make it curated" }).click();
  await expect(page.getByText("Done. What it printed is in the Console.")).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.getByText("catalog/generated is what the slots and inputs build."),
  ).toBeVisible();
  expect(readFileSync(path, "utf8")).toContain("-by-hand");
});

test("a catalog from before beta.27 is upgraded from the app, every file listed first", async ({
  page,
}) => {
  // The Forge metarepo as beta.26 left it: catalog/generated and nothing else of the build's.
  const root = await slotsMetarepo();
  await rm(join(root, "catalog/sources"), { recursive: true });
  await rm(join(root, ".index"), { recursive: true, force: true });
  const old = await startApp(root);
  try {
    const before = catalogFiles(root);
    await open(page, old, "catalog-builds");
    const panel = page.locator(".panel", {
      has: page.getByRole("heading", { name: "Upgrade to source slots" }),
    });
    await expect(panel.getByText("The first build after it gives every record")).toBeVisible();
    await expect(
      panel.getByText(/is copied to catalog\/sources\/legacy\/generated-before-upgrade/),
    ).toBeVisible();
    await expect(panel.getByRole("table", { name: "The slots the upgrade writes" })).toBeVisible();
    // The upgrade's other steps (the org pack's files) wait first: they may change what this
    // step writes, so it is confirmed only after them.
    const others = panel.getByRole("button", { name: "Run the upgrade" });
    await expect(
      others.or(panel.getByRole("button", { name: /^Review the / })).first(),
    ).toBeVisible();
    if (await others.isVisible()) {
      await accessible(page, "the upgrade, other steps waiting");
      await others.scrollIntoViewIfNeeded();
      await shot(page, "upgrade-others-1440-dark");
      await others.click();
      await expect(panel.getByText("Other upgrade steps wait first")).toBeHidden({
        timeout: 60_000,
      });
    }
    expect(existsSync(join(root, "catalog/sources"))).toBe(false);
    const review = panel.getByRole("button", { name: /^Review the \d+ files it writes…$/ });
    await expect(review).toBeVisible({ timeout: 30_000 });
    await accessible(page, "the upgrade's dry run");
    await panel.scrollIntoViewIfNeeded();
    await shot(page, "upgrade-1440-dark");
    const n = Number(/\d+/.exec((await review.textContent()) ?? "")![0]);
    await review.click();
    const dialog = page.getByRole("dialog", { name: `Upgrade: write ${n} files` });
    await expect(
      dialog.getByRole("list", { name: "Every file the upgrade writes" }).getByRole("listitem"),
    ).toHaveCount(n);
    await accessible(page, "the upgrade's confirm");
    await shot(page, "confirm-upgrade-1440-dark");
    const write = dialog.getByRole("button", { name: `Write ${n} files` });
    await dialog.getByLabel(`Type ${n} to confirm exactly these`).fill(String(n - 1));
    await expect(write).toBeDisabled();
    expect(existsSync(join(root, "catalog/sources"))).toBe(false);
    await dialog.getByLabel(`Type ${n} to confirm exactly these`).fill(String(n));
    await write.click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });
    await expect(
      page.getByText("catalog/generated is what the slots and inputs build."),
    ).toBeVisible();
    await expect(panel).toBeHidden();
    // Every record adopted, the catalog byte for byte as it was.
    expect(existsSync(join(root, "catalog/sources/build.json"))).toBe(true);
    expect(catalogFiles(root)).toEqual(before);
  } finally {
    await stopApp(old);
  }
});
