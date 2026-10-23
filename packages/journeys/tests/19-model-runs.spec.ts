import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runsDirOf } from "@maycombhq/core";
import {
  accessible,
  expect,
  forgeMetarepo,
  open,
  startApp,
  stopApp,
  test,
  type App,
} from "../support/app.js";

/**
 * Model runs (ADR 0106): what Atticus asked a model and what came back. The metarepo has a
 * knowledge scan handed back twice (rounds 1 and 2 failed their checks, round 3 waits)
 * and a story run on add-transfer-limit, as the hand-off runtime writes them under .runs/.
 * The list, one run's prompt, answer and the problems handed back, the rounds, the filter, and
 * WCAG 2.1 AA in the dark and light themes. The server has no model, so the steps stay commands
 * to copy, and starting one is refused. Everything is the invented Forge estate (CLAUDE.md rule 3).
 */

const agent = (id: string) => ({
  schemaVersion: 1,
  id,
  role: "architect",
  description: "Reads pages.",
  inputs: ["documents"],
  outputArtifact: "specs",
  tokenBudget: 4000,
  allowedRuntimes: ["hand-off"],
});
const data = (id: string, origin: string, text: string) =>
  `<atticus-data id="${id}" kind="document" origin="${origin}">\n${text}\n</atticus-data>`;

/** A run as the hand-off runtime writes it: run.json, its prompt, and the answer in its folder. */
async function seed(
  root: string,
  o: {
    n: number;
    change: string;
    agent: string;
    prompt: string;
    state: string;
    answer?: string;
    output: string;
  },
) {
  const id = `run-2026102303400${o.n}-0001`;
  const at = `2026-10-23T03:40:0${o.n}Z`;
  const dir = join(runsDirOf(root), o.change, id);
  await mkdir(dir, { recursive: true });
  const sources = [...o.prompt.matchAll(/origin="([^"]+)"/g)].map((m, i) => ({
    id: `s${i}`,
    kind: "document",
    origin: m[1],
    bytes: 1,
    tokens: 1,
    classification: "internal",
    sha256: "0".repeat(64),
    trusted: false,
  }));
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({
      runId: id,
      request: {
        change: o.change,
        agent: agent(o.agent),
        pack: {
          prompt: o.prompt,
          manifest: {
            schemaVersion: 1,
            change: o.change,
            agent: o.agent,
            createdAt: at,
            budget: 4000,
            totalTokens: 900 + o.n,
            sources,
            dropped: [],
            promptSha256: "0".repeat(64),
          },
        },
        outputPath: o.output,
        outputIn: "run",
      },
      runtime: "hand-off",
      state: o.state,
      attempt: 1,
      startedAt: at,
      ...(o.state !== "waiting" ? { finishedAt: at } : {}),
      errors: [],
    }),
  );
  await writeFile(join(dir, "prompt.md"), o.prompt);
  await writeFile(join(dir, "context-manifest.json"), "{}");
  if (o.answer !== undefined) await writeFile(join(dir, o.output), o.answer);
  return id;
}

const ids: string[] = [];
let app: App | undefined;
const a = () => {
  if (!app) throw new Error("The journey's app hasn't started.");
  return app;
};
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const root = await forgeMetarepo();
  const scan = { change: "knowledge-scan", agent: "knowledge-reader", output: "items.yaml" };
  ids.push(
    await seed(root, {
      ...scan,
      n: 1,
      prompt: "# Task: read the pages\n",
      state: "failed",
      answer: "items:\n  - id: firewall-rule-request\n",
    }),
    await seed(root, {
      ...scan,
      n: 2,
      prompt: `# Task: read the pages\n<b>not bold</b>\n\n${data("9-problems", "checks on attempt 1", "The answer above failed these checks.\n- team ledger-team: quote: the quote is not on the page, word for word\n- request firewall-rule-request: title: Invalid input")}\n\n${data("8-previous", "attempt 1", "items:\n  - id: firewall-rule-request\n")}\n`,
      state: "failed",
      answer: "items:\n  - id: firewall-rule-request\n    title: Network firewall rule\n",
    }),
    await seed(root, {
      ...scan,
      n: 3,
      prompt: `# Task: read the pages\n\n${data("9-problems", "checks on attempt 2", "The answer above failed these checks.\n- request firewall-rule-request: owner: Required")}\n\n${data("8-previous", "attempt 2", "items:\n  - id: firewall-rule-request\n    title: Network firewall rule\n")}\n`,
      state: "waiting",
    }),
    await seed(root, {
      n: 4,
      change: "add-transfer-limit",
      agent: "story-writer",
      output: "stories.md",
      prompt: "# Task: write the stories for add-transfer-limit\n",
      state: "produced",
      answer: "## Story 1\nA customer sees their daily limit.\n",
    }),
  );
  app = await startApp(root);
});
test.afterAll(async () => {
  if (app) await stopApp(app);
});

test("Model runs lists every run, newest first, and filters it", async ({ page }) => {
  await open(page, a(), "runs");
  await expect(page.getByRole("heading", { level: 2, name: "Model runs" })).toBeVisible();
  const table = page.getByRole("region", { name: "Model runs, newest first" });
  const rows = table.locator("tbody tr");
  await expect(rows).toHaveCount(4);
  for (const h of ["Step or change", "Agent", "Round", "State", "Answered", "Handed back", "When"])
    await expect(table.getByRole("columnheader", { name: h })).toBeVisible();
  // Newest first: the story run, then the scan's rounds 3, 2 and 1.
  await expect(rows.nth(0)).toContainText("add-transfer-limit");
  await expect(rows.nth(0)).toContainText("story-writer");
  await expect(rows.nth(1)).toContainText("Waiting for its answer");
  await expect(rows.nth(1)).toContainText("Not yet");
  await expect(rows.nth(2)).toContainText("Failed");
  await expect(rows.nth(2)).toContainText("2 problems");
  await expect(rows.nth(2).getByRole("cell").nth(2)).toHaveText("2");
  await accessible(page, "Model runs");

  const box = page.getByLabel("Filter");
  await expect(box).toHaveAttribute("placeholder", "Words to match, for example forge-ledger");
  await box.fill("STORY-writer");
  await expect(rows).toHaveCount(1);
  await expect(page.locator("[aria-live=polite]").filter({ hasText: /shown/ })).toHaveText(
    "1 of 4 shown",
  );
  await box.fill("no-such-run");
  await expect(page.getByText("Nothing matches “no-such-run”.")).toBeVisible();
  await page.getByRole("button", { name: "Clear the filter" }).click();
  await expect(box).toBeFocused();
  await expect(rows).toHaveCount(4);

  // One change's runs, as a step's page links to them.
  await open(page, a(), "runs?change=add-transfer-limit");
  await expect(rows).toHaveCount(1);
  await expect(page.getByText("Only the runs of add-transfer-limit.")).toBeVisible();
  await page.getByRole("link", { name: "Show every run" }).click();
  await expect(rows).toHaveCount(4);
});

test("one run: the prompt and answer as text, and what the checks handed back", async ({
  page,
}) => {
  await open(page, a(), "runs");
  await page.getByRole("link", { name: new RegExp(ids[1]!) }).click();
  await expect(page).toHaveURL(new RegExp(`#/runs\\?run=${ids[1]}$`));
  await expect(
    page.getByRole("heading", { level: 2, name: "knowledge-scan, round 2" }),
  ).toBeVisible();
  const prompt = page.getByRole("region", { name: "Prompt, scrolls on its own" });
  await expect(prompt).toContainText("# Task: read the pages");
  // A prompt is data: its markup is shown as text, never rendered.
  await expect(prompt).toContainText("<b>not bold</b>");
  await expect(prompt.locator("b")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Answer, scrolls on its own" })).toContainText(
    "title: Network firewall rule",
  );
  const back = page.locator("section[aria-labelledby=run-back]");
  await expect(
    back.getByRole("heading", { name: "Round 1: the problems the checks found" }),
  ).toBeVisible();
  await expect(back).toContainText(
    "team ledger-team: quote: the quote is not on the page, word for word",
  );
  await expect(back).toContainText("request firewall-rule-request: title: Invalid input");
  await expect(
    back.getByRole("region", { name: "The answer round 1 gave, scrolls on its own" }),
  ).toContainText("items:\n  - id: firewall-rule-request");
  // A long text scrolls in its own box, which a keyboard reaches.
  await prompt.focus();
  await expect(prompt).toBeFocused();
  await accessible(page, "one model run (dark)");
  await page.emulateMedia({ colorScheme: "light" });
  await accessible(page, "one model run (light)");
  await page.emulateMedia({ colorScheme: "dark" });

  // The rounds of the step link to each other.
  const rounds = page.getByRole("navigation", { name: "Rounds of this step" });
  await expect(rounds.getByRole("link")).toHaveText(["Round 1", "Round 2", "Round 3"]);
  await expect(rounds.getByRole("link", { name: "Round 2" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await rounds.getByRole("link", { name: "Round 3" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "knowledge-scan, round 3" }),
  ).toBeVisible();
  await expect(page.getByText("No answer yet: the run is waiting for one.")).toBeVisible();
  await expect(
    back.getByRole("heading", { name: "Round 2: the problems the checks found" }),
  ).toBeVisible();
  await expect(back).toContainText("request firewall-rule-request: owner: Required");
  await page.getByRole("link", { name: "Back to every run" }).click();
  await expect(page).toHaveURL(/#\/runs$/);
});

test("the list in the light theme, and a run that isn't there", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await open(page, a(), "runs");
  await expect(page.getByRole("region", { name: "Model runs, newest first" })).toBeVisible();
  await accessible(page, "Model runs (light)");
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page, a(), "runs?run=run-1-0001");
  await expect(page.getByRole("alert").first()).toContainText("There is no run run-1-0001");
  await accessible(page, "a model run that isn't there");
});

test("a step's page links to its runs; without a model a step stays a command to copy", async ({
  page,
}) => {
  await open(page, a(), "stories?change=add-transfer-limit");
  await expect(
    page.getByRole("link", { name: "Model runs for add-transfer-limit" }).first(),
  ).toHaveAttribute("href", "#/runs?change=add-transfer-limit");
  const next = page.locator("section[aria-labelledby=run-next]");
  await expect(
    next.getByRole("button", { name: /^Copy the command: atticus plan stories/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Run with/ })).toHaveCount(0);
  // The server says it has no model, and refuses to start a step.
  // The page's API token, from the meta tag the app's page carries.
  const token = (await page.locator('meta[name="atticus-token"]').getAttribute("content")) ?? "";
  const r = await page.evaluate(async (token) => {
    const headers = { "X-Atticus-Token": token, "Content-Type": "application/json" };
    const list = (await (await fetch("/api/runs?limit=1", { headers })).json()) as {
      serverModel: unknown;
    };
    const post = await fetch("/api/runs", {
      method: "POST",
      headers,
      body: JSON.stringify({ args: ["plan", "stories", "add-transfer-limit"] }),
    });
    return { serverModel: list.serverModel, status: post.status };
  }, token);
  expect(r).toEqual({ serverModel: null, status: 409 });

  await open(page, a(), "knowledge");
  await expect(
    page.getByRole("link", { name: "Model runs of the knowledge steps" }).first(),
  ).toHaveAttribute("href", "#/runs?q=knowledge");
  await page.getByRole("link", { name: "Model runs of the knowledge steps" }).first().click();
  await expect(page.getByLabel("Filter")).toHaveValue("knowledge");
  await expect(
    page.getByRole("region", { name: "Model runs, newest first" }).locator("tbody tr"),
  ).toHaveCount(3);
});
