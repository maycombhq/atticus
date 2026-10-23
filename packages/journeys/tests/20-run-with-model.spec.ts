import { writeFile } from "node:fs/promises";
import { join } from "node:path";
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
 * Run with the server's model, in a browser (ADR 0106): the org pack's runtime.yaml sets an
 * Anthropic model, so an AI step's page offers Run with anthropic beside the command to copy.
 * No network (CLAUDE.md rule 5): the server's answer to the start and its job are stubbed in the
 * page, so the step never reaches a model; the journey checks the 202 it gets and the button's
 * states. Everything is the invented Forge estate (rule 3).
 */

let app: App | undefined;
const a = () => {
  if (!app) throw new Error("The journey's app hasn't started.");
  return app;
};
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const root = await forgeMetarepo();
  await writeFile(
    join(root, "org-pack", "runtime.yaml"),
    [
      "schemaVersion: 1",
      "assistants: { allowed: [copilot, claude-code], default: copilot }",
      "editors: [vscode, intellij]",
      "modes: { allowed: [hand-off, model], default: hand-off }",
      "budgets: { defaultTokens: 150000 }",
      "retention: { runsDays: 30 }",
      "adapters:",
      "  model: { type: anthropic }",
      "  workTracker: { type: mock }",
      "  serviceDesk: { type: mock }",
      "  gitHost: { type: mock }",
      "  notify: { type: mock }",
      "",
    ].join("\n"),
  );
  app = await startApp(root);
});
test.afterAll(async () => {
  if (app) await stopApp(app);
});

test("Run with anthropic starts the step, says it is running, then shows the end", async ({
  page,
}) => {
  const started: unknown[] = [];
  let done = false;
  const release = () => (done = true);
  // The start and its job, stubbed: the step never runs, so no model is called.
  await page.route("**/api/runs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    started.push(route.request().postDataJSON());
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ jobId: "job-stub", model: "anthropic" }),
    });
  });
  await page.route("**/api/jobs/job-stub", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "job-stub",
        kind: "step",
        state: done ? "done" : "running",
        progress: {
          done: done ? 1 : 0,
          total: 1,
          message: done ? "Done" : "Running atticus plan stories add-transfer-limit with anthropic",
        },
        startedAt: "2026-10-23T03:40:00Z",
        errors: [],
        ...(done ? { result: { code: 0, lines: ["Wrote stories.md"] } } : {}),
      }),
    });
  });

  await open(page, a(), "stories?change=add-transfer-limit");
  const next = page.locator("section[aria-labelledby=run-next]");
  const run = next.getByRole("button", { name: "Run with anthropic" });
  await expect(run).toBeVisible();
  await expect(run).toBeEnabled();
  // The copy buttons stay beside it.
  await expect(
    next.getByRole("button", {
      name: /^Copy the command: atticus plan stories add-transfer-limit$/,
    }),
  ).toBeVisible();
  await accessible(page, "a step with Run with anthropic");

  const status = await page.evaluate(async () => {
    const token = document.querySelector<HTMLMetaElement>('meta[name="atticus-token"]')!.content;
    const r = await fetch("/api/runs?limit=1", { headers: { "X-Atticus-Token": token } });
    return ((await r.json()) as { serverModel: unknown }).serverModel;
  });
  expect(status).toBe("anthropic");

  const answer = page.waitForResponse(
    (r) => r.url().endsWith("/api/runs") && r.request().method() === "POST",
  );
  await run.click();
  expect((await answer).status()).toBe(202);
  expect(started).toEqual([{ args: ["plan", "stories", "add-transfer-limit"] }]);
  const busy = next.getByRole("button", { name: "Running…" });
  await expect(busy).toBeDisabled();
  await expect(
    next.getByText("The step is running. The button comes back when it ends."),
  ).toBeVisible();
  await expect(next.getByText("Started on the server with anthropic.")).toBeVisible();
  await expect(
    next.getByText("Running atticus plan stories add-transfer-limit with anthropic"),
  ).toBeVisible();
  await accessible(page, "a step while it runs");

  release();
  await expect(next.getByText("Done: the step finished.")).toBeVisible();
  await expect(next.getByRole("region", { name: "What the step printed" })).toHaveText(
    "Wrote stories.md",
  );
  await expect(run).toBeEnabled();
  await expect(next.getByRole("link", { name: "Open Model runs" })).toHaveAttribute(
    "href",
    "#/runs",
  );
  await accessible(page, "a step that ended");
});

test("a refusal shows its detail, and the button comes back", async ({ page }) => {
  await page.route("**/api/runs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 400,
      contentType: "application/problem+json",
      body: JSON.stringify({
        type: "about:blank",
        title: "Bad request",
        status: 400,
        detail: "atticus plan stories isn't an AI step; the app starts only those.",
      }),
    });
  });
  await open(page, a(), "stories?change=add-transfer-limit");
  const next = page.locator("section[aria-labelledby=run-next]");
  await next.getByRole("button", { name: "Run with anthropic" }).click();
  await expect(next.getByRole("alert")).toHaveText(
    "Couldn't start it: atticus plan stories isn't an AI step; the app starts only those.",
  );
  await expect(next.getByRole("button", { name: "Run with anthropic" })).toBeEnabled();
});
