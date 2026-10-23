import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import {
  accessible,
  atticus,
  expect,
  forgeMetarepo,
  open,
  startApp,
  stopApp,
  test,
  type App,
} from "../support/app.js";

/**
 * Waiting on you grouped by change, and one filter wherever a list grows (ADR 0105 addendum):
 * two changes with open needs, questions in two repos, the filter on Waiting on you, Questions
 * and Manual steps, each with its label, a polite count and a Clear the filter that takes the
 * keyboard back to the box. Everything is the invented Forge estate (CLAUDE.md rule 3).
 */

const needs = (change: string, list: { item: string; title: string; kind: string }[]) =>
  stringify({
    schemaVersion: 1,
    change,
    updatedAt: "2026-10-20T09:00:00Z",
    needs: list.map((n) => ({
      ...n,
      for: "change",
      why: "The ledger calls Northwind Pay through a new route.",
      from: "assistant",
      status: "open",
    })),
  });

const question = (id: string, repo: string, words: string) =>
  stringify({
    schemaVersion: 1,
    id,
    askedBy: {
      step: "scan-survey",
      command: `atticus scan survey ${repo}`,
      at: "2026-10-21T12:00:00.000Z",
    },
    repo,
    question: words,
    options: [
      { label: "Generated", means: "nobody edits it", changes: "the scan leaves it out" },
      { label: "Product", means: "it ships", changes: "the scan reads it" },
    ],
    evidence: ["docs/playground.js:1"],
    scope: { level: "repo", id: repo },
    state: "open",
    rerun: `atticus scan survey ${repo} --force`,
  });

let app: App | undefined;
const a = () => {
  if (!app) throw new Error("The journey's app hasn't started.");
  return app;
};
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const root = await forgeMetarepo();
  const put = async (rel: string, text: string) => {
    const f = join(root, rel);
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, text);
  };
  atticus(
    root,
    "change",
    "new",
    "Fix the Northwind timeout",
    "--type",
    "feature",
    "--id",
    "fix-northwind-timeout",
  );
  await put(
    "openspec/changes/add-transfer-limit/needs.yaml",
    needs("add-transfer-limit", [
      { item: "firewall-rule-request", title: "Network firewall rule", kind: "request" },
    ]),
  );
  await put(
    "openspec/changes/fix-northwind-timeout/needs.yaml",
    needs("fix-northwind-timeout", [
      { item: "northwind-pay", title: "Northwind Pay", kind: "vendor" },
    ]),
  );
  await put(
    "questions/q-a4a06bcb15a5.yaml",
    question("q-a4a06bcb15a5", "forge-notes", "Is docs/ a generated playground?"),
  );
  await put(
    "questions/q-0000000000b1.yaml",
    question("q-0000000000b1", "forge-ledger", "Does the ledger retry a failed post?"),
  );
  app = await startApp(root);
});
test.afterAll(async () => {
  if (app) await stopApp(app);
});

test("Waiting on you lists what needs a person by change, and filters it", async ({ page }) => {
  await open(page, a(), "home");
  const panel = page.locator("section", {
    has: page.getByRole("heading", { name: "Needs a person", level: 2 }),
  });
  const add = panel.locator("section[aria-labelledby=waiting-add-transfer-limit]");
  const fix = panel.locator("section[aria-labelledby=waiting-fix-northwind-timeout]");
  const none = panel.locator("section[aria-labelledby=waiting-no-change]");
  await expect(add.getByRole("heading", { level: 3 })).toContainText("add-transfer-limit");
  await expect(add.getByRole("link", { name: "Add a daily transfer limit" })).toHaveAttribute(
    "href",
    "#/changes/add-transfer-limit",
  );
  await expect(add.getByRole("heading", { name: "Open needs", level: 4 })).toBeVisible();
  await expect(add).toContainText("Network firewall rule");
  await expect(fix.getByRole("heading", { level: 3 })).toContainText("1 waiting");
  await expect(fix).toContainText("Northwind Pay");
  await expect(fix).not.toContainText("Network firewall rule");
  // What belongs to no change: the questions, by repo.
  await expect(none.getByRole("heading", { name: "Questions · forge-notes" })).toBeVisible();
  await expect(none.getByRole("heading", { name: "Questions · forge-ledger" })).toBeVisible();
  // The counts and their links stay as they were.
  await expect(page.getByRole("link", { name: /^Needs still open 2$/ })).toHaveAttribute(
    "href",
    "#/changes?across=needs",
  );
  await accessible(page, "Waiting on you, by change");

  const box = panel.getByLabel("Filter");
  await expect(box).toHaveAttribute("placeholder", "Words to match, for example forge-ledger");
  await box.fill("FIREWALL");
  await expect(fix).toHaveCount(0);
  await expect(add).toContainText("Network firewall rule");
  await expect(panel.locator("[aria-live=polite]").first()).toHaveText(/^1 of \d+ shown$/);
  await expect(box).toBeFocused();
  // A change's id keeps everything of it.
  await box.fill("fix-northwind-timeout");
  await expect(add).toHaveCount(0);
  await expect(fix).toContainText("Northwind Pay");
  // A repo finds its questions.
  await box.fill("forge-ledger");
  await expect(none).toContainText("Does the ledger retry a failed post?");
  await expect(none).not.toContainText("Is docs/ a generated playground?");

  await box.fill("no-such-thing");
  await expect(panel).toContainText("Nothing matches “no-such-thing”.");
  await accessible(page, "Waiting on you, nothing matching");
  await panel.getByRole("button", { name: "Clear the filter" }).click();
  await expect(box).toHaveValue("");
  await expect(box).toBeFocused();
  await expect(add).toBeVisible();
  await expect(fix).toBeVisible();
});

test("Questions: a filter and a repo picker beside Open and All", async ({ page }) => {
  await open(page, a(), "questions");
  const list = page.locator("section", {
    has: page.getByRole("heading", { name: "Questions", level: 2 }),
  });
  await expect(list.getByRole("link")).toHaveCount(2);
  await page.getByLabel("Repo").selectOption("forge-notes");
  await expect(list.getByRole("link")).toHaveCount(1);
  await expect(list).toContainText("Is docs/ a generated playground?");
  await expect(list.locator("[aria-live=polite]")).toHaveText("1 of 2 shown");

  const box = page.getByLabel("Filter");
  await box.fill("retry");
  await expect(list).toContainText("Nothing matches “retry” in forge-notes.");
  await accessible(page, "Questions, nothing matching");
  await list.getByRole("button", { name: "Clear the filter" }).click();
  await expect(box).toBeFocused();
  await expect(page.getByLabel("Repo")).toHaveValue("");
  await expect(list.getByRole("link")).toHaveCount(2);
  await box.fill("q-0000000000b1");
  await expect(list.getByRole("link")).toHaveCount(1);
  await expect(list).toContainText("Does the ledger retry a failed post?");
});

test("Manual steps: a filter beside the change picker", async ({ page }) => {
  await open(page, a(), "todo");
  const box = page.getByLabel("Filter");
  await expect(box).toHaveAttribute("placeholder", "Words to match, for example forge-ledger");
  await box.fill("no-such-step");
  await expect(page.locator("[aria-live=polite]").filter({ hasText: /shown/ })).toHaveText(
    /^0 of \d+ shown$/,
  );
  await expect(box).toBeFocused();
  await accessible(page, "Manual steps, filtered");
});
