import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
 * ADR 0203 A, in the app: a person accepts a stage's finding. On the tidy Forge estate the
 * feature stage places a new flow in forge-limits, a repo the estate doesn't have yet; the
 * stage's checks block on it twice (feature.unknown-repo), and the stage's thread shows it with
 * Accept. The tech lead knows better than the map (the repo is created in this release): Accept
 * asks why, says who it records and previews what accepting does; the acceptance is written as
 * `atticus finding … waive` writes it; the thread lists it apart, by whom and why; the
 * assistant's next answer passes and the stage ends done. Axe runs on each state. Invented
 * names only (CLAUDE.md rule 3).
 */

const CHANGE = "add-transfer-limit";
const REASON = "forge-limits is created in this release, before the limits go live";

/** The assistant's placement, as it writes it: the new flow in a repo nobody has read. */
const ANSWER = `summary: Each account gets a daily transfer limit, checked by a new limits service.
features: []
flows: []
newFlows:
  - name: Check the daily transfer limit
    repo: forge-limits
    why: A limits service checks each transfer against the account's limit.
`;

let app: App | undefined;
const a = () => {
  if (!app) throw new Error("The journey's app hasn't started.");
  return app;
};
const dir = () => join(a().root, "openspec/changes", CHANGE);

/** The newest run waiting for its answer, as the stage wrote it. */
async function waitingRun(root: string): Promise<{ id: string; out: string }> {
  const runs = join(root, ".runs", CHANGE);
  const seen: string[] = [];
  for (const id of (await readdir(runs)).sort().reverse()) {
    const r = JSON.parse(await readFile(join(runs, id, "run.json"), "utf8")) as {
      state: string;
      request: { outputPath: string };
    };
    if (r.state === "waiting") return { id, out: join(runs, id, r.request.outputPath) };
    seen.push(`${id} ${r.state}`);
  }
  throw new Error(`No run waits: ${seen.join(", ")}`);
}

/** The newest run whose answer didn't pass its checks: the one the stage waits on. */
async function answeredRun(root: string): Promise<{ id: string; out: string }> {
  const runs = join(root, ".runs", CHANGE);
  for (const id of (await readdir(runs)).sort().reverse()) {
    const r = JSON.parse(await readFile(join(runs, id, "run.json"), "utf8")) as {
      state: string;
      request: { outputPath: string };
    };
    if (r.state === "failed" || r.state === "waiting")
      return { id, out: join(runs, id, r.request.outputPath) };
  }
  throw new Error("No run waits for an answer.");
}

/** The finding's file in the newest round of the stage's own gate. */
async function findingFile(id: string): Promise<string> {
  const gate = join(dir(), "review/stage-feature");
  const rounds = (await readdir(gate)).filter((r) => /^\d+$/.test(r)).sort((x, y) => +y - +x);
  return join(gate, rounds[0]!, `${id}.yaml`);
}

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  // Before the app starts, as a terminal would: the stage hands the draft to the assistant, which
  // keeps the repo nobody has; the stage's checks refuse it until its three checks are spent,
  // then the stage takes it and hands it back once more, blocked on feature.unknown-repo.
  const root = await forgeMetarepo();
  atticus(root, "change", "feature", CHANGE);
  const first = await waitingRun(root);
  await writeFile(first.out, ANSWER);
  for (let i = 0; i < 3; i++) atticus(root, "handoff", "done", first.id);
  atticus(root, "change", "feature", CHANGE, "--resume", first.id);
  app = await startApp(root);
});
test.afterAll(async () => {
  if (app) await stopApp(app);
});

test("a tech lead accepts the stage's finding with a reason, and the stage ends done", async ({
  page,
}) => {
  await open(page, a(), `feature-design?change=${CHANGE}`);
  const thread = page.getByRole("region", { name: "The feature stage, as one conversation" });
  const finding = thread.getByRole("article", { name: /^The stage's checks found: stage-/ });
  await expect(finding).toBeVisible();
  await expect(finding.getByText(/is put in repo forge-limits, which the estate/)).toBeVisible();
  const id = (await finding.getAttribute("aria-label"))!.replace(/^.*: /, "");
  await accessible(page, "a stage's thread with a finding a person may accept");

  // Accept asks who and why, and previews what accepting does, before anything is written.
  await finding.getByRole("button", { name: `Accept ${id}…` }).click();
  const form = thread.getByRole("form", { name: "Accept feature.unknown-repo" });
  await expect(form).toBeVisible();
  await expect(form.getByText("priya, your Git user as the app knows it")).toBeVisible();
  await expect(
    form.getByText(/^Nothing else blocks the feature stage: your assistant's next answer/),
  ).toBeVisible();
  await expect(form.getByText(/^The later stages know the repo as a new one/)).toBeVisible();
  await accessible(page, "the Accept form");

  // Empty: a reason is required.
  await form.getByRole("button", { name: "Accept it" }).click();
  await expect(form.getByRole("alert")).toHaveText(
    "Write why you accept it first: an acceptance always has a reason.",
  );
  await accessible(page, "the Accept form without a reason");
  const file = await findingFile(id);
  expect(await readFile(file, "utf8")).toContain("state: open");

  await form.getByRole("textbox", { name: "Why you accept it (required)" }).fill(REASON);
  await form.getByRole("button", { name: "Accept it" }).click();

  // Written as `atticus finding … waive` writes it, in the person's name.
  await expect.poll(async () => readFile(file, "utf8")).toContain("state: waived");
  const written = await readFile(file, "utf8");
  expect(written).toContain("by: priya");
  expect(written).toContain(`reason: ${REASON}`);
  const accepted = thread.getByRole("region", { name: "Accepted at the feature stage" });
  await expect(accepted.getByText(`Accepted by priya: ${REASON}.`, { exact: true })).toBeVisible();
  await expect(thread.getByRole("button", { name: `Accept ${id}…` })).toHaveCount(0);
  await expect(thread.getByRole("status").filter({ hasText: /^Accepted\./ })).toBeVisible();
  await accessible(page, "a stage's thread with an accepted finding");

  // The assistant's last answer kept the repo, and the app checked it as soon as it started: it
  // didn't pass then. The tech lead goes on in the app (the stage was started in a terminal):
  // the next round is the same prompt, still with the assistant, which hands the same placement
  // in again, in its own words. It passes now, and the stage ends done with nothing blocking.
  const next = await answeredRun(a().root);
  const again = thread.getByRole("button", { name: "Start the next round", exact: true });
  await again.click();
  await expect(again).toBeEnabled();
  await expect(thread.getByRole("alert")).toHaveCount(0);
  await writeFile(
    next.out,
    ANSWER.replace("checked by a new limits service", "which a new limits service checks"),
  );
  await expect
    .poll(
      async () => {
        const loop = await readFile(join(dir(), "stage/feature.yaml"), "utf8");
        return /^state: (\S+)$/m.exec(loop)?.[1];
      },
      { timeout: 60_000 },
    )
    .toBe("done");
  await expect(thread.getByText(/^The stage is done/)).toBeVisible({ timeout: 30_000 });
  await expect(accepted.getByText(`Accepted by priya: ${REASON}.`, { exact: true })).toBeVisible();
  // The command line says the same of the change.
  expect(atticus(a().root, "change", "status", CHANGE)).toContain(
    "1 finding accepted at the feature stage: feature.unknown-repo, by priya.",
  );
  await accessible(page, "a stage done after a person accepted its finding");
});
