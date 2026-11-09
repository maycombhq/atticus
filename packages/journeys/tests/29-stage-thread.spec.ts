import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { accessible, atticus, expect, forgeJourney, open, test } from "../support/app.js";

/**
 * ADR 0189: a stage is one conversation. A tech lead takes a stage round in the app alone: Start
 * writes the prompt into the stage's thread; the assistant (simulated here) writes the answer
 * file; the thread shows it checked without anyone pressing Done; a reply starts the next round,
 * whose prompt carries it. An architect draws a component that doesn't exist yet and the
 * architecture stage's checks know it as planned. A question whose line didn't match is kept.
 */
const app = forgeJourney();
const CHANGE = "add-transfer-limit";
const dir = () => join(app().root, "openspec/changes", CHANGE);

/** The drafter's answer, as an assistant writes it (invented, on the Forge estate). */
const DRAFT = `=== proposal.md
# Proposal

## Why

Portal customers can send any amount in a day; two accounts were drained last month.

## What Changes

- ledger-api refuses a transfer over the account's daily limit on POST /transfers.

## Capabilities

### New Capabilities
- \`transfer-limits\`: a daily transfer limit per account

## Systems

| System (catalog id) | New, modified or retired | Why |
| --- | --- | --- |
| ledger | modified | checks and stores the limit |

## Impact

POST /transfers gains an error.

## Open questions

- Does the limit reset at midnight in the account's time zone? (product owner)
=== specs/transfer-limits/spec.md
## ADDED Requirements

### Requirement: Daily transfer limit
The system SHALL refuse a transfer that would take an account over its daily limit.

#### Scenario: Transfer over the limit
- **WHEN** an account with a limit of 1000 has sent 900 today and asks to send 200
- **THEN** the transfer is refused with error LIMIT_EXCEEDED
`;

/** The run of the change waiting for its answer, as the server wrote it. */
async function waitingRun(): Promise<{ id: string; out: string; prompt: string }> {
  const runs = join(app().root, ".runs", CHANGE);
  for (const id of (await readdir(runs)).sort().reverse()) {
    const r = JSON.parse(await readFile(join(runs, id, "run.json"), "utf8")) as {
      state: string;
      request: { outputPath: string };
    };
    if (r.state === "waiting")
      return {
        id,
        out: join(runs, id, r.request.outputPath),
        prompt: await readFile(join(runs, id, "prompt.md"), "utf8"),
      };
  }
  throw new Error("No run waits.");
}

test("a stage round in its thread only: Start, the answer arrives by itself, a reply starts the next round", async ({
  page,
}) => {
  // The change starts from its brief: the proposal is the first step's to draft.
  for (const f of ["proposal.md", "specs", "interfaces.md"])
    await rm(join(dir(), f), { recursive: true, force: true });
  await open(page, app(), `cockpit?change=${CHANGE}`);
  const thread = page.getByRole("region", { name: "The proposal, as one conversation" });
  await expect(thread).toBeVisible();
  await thread.getByRole("button", { name: "Start the stage" }).click();
  // The prompt is in the thread, with Copy; nothing sends the person to Set up.
  await expect(thread.getByRole("button", { name: /^Copy the prompt of run-/ })).toBeVisible();
  await expect(thread.getByText("Waiting for the answer").first()).toBeVisible();
  const first = await waitingRun();
  expect(first.prompt).not.toContain("atticus handoff done");
  expect(first.prompt.trimEnd()).toMatch(/There is nothing to run\.$/);
  await accessible(page, "a stage's thread, its prompt waiting");

  // The assistant writes the answer file; nobody presses Done.
  await writeFile(first.out, DRAFT);
  await expect(thread.getByText("Passed the checks")).toBeVisible({ timeout: 30_000 });
  await expect(thread.getByText("The app checked it when the file arrived.")).toBeVisible();
  await expect
    .poll(async () => readFile(join(dir(), "proposal.md"), "utf8").catch(() => ""), {
      timeout: 30_000,
    })
    .toContain("## What Changes");

  // A reply starts the next round, whose prompt carries it.
  await thread
    .getByRole("textbox", { name: "Tell the assistant…" })
    .fill("Name the team that owns the limit in Impact.");
  await thread.getByRole("button", { name: "Send and start the next round" }).click();
  await expect(thread.getByText("Name the team that owns the limit in Impact.")).toBeVisible();
  await expect
    .poll(
      async () => {
        const r = await waitingRun().catch(() => undefined);
        return r && r.id !== first.id ? "the next round" : "none yet";
      },
      { timeout: 60_000 },
    )
    .toBe("the next round");
  const next = await waitingRun();
  expect(next.prompt).toContain("Name the team that owns the limit in Impact.");
  await expect(thread.getByText("Waiting for the answer").first()).toBeVisible();
  await accessible(page, "a stage's thread after a reply");
});

test("a question whose line didn't match is shown in the thread, and kept anyway", async ({
  page,
}) => {
  const brief = `openspec/changes/${CHANGE}/brief.md`;
  await writeFile(
    join(dir(), "stage/feature.yaml"),
    stringify({
      schemaVersion: 1,
      change: CHANGE,
      stage: "feature",
      iteration: 1,
      state: "drafting",
      updatedAt: "2026-11-09T09:00:00Z",
      dropped: [
        {
          key: "0123456789ab",
          question: "Does a refused transfer notify the account owner?",
          evidence: [`${brief}:31`],
          nearest: `${brief}:29`,
          iteration: 1,
          at: "2026-11-09T09:00:00Z",
        },
      ],
    }),
  );
  await open(page, app(), `feature-design?change=${CHANGE}`);
  const thread = page.getByRole("region", { name: "The feature stage, as one conversation" });
  // Said twice: the item itself, and the thread's line about it.
  await expect(thread.getByText("1 question couldn't be kept: its line didn't match")).toHaveCount(
    2,
  );
  await expect(
    thread.getByText(`Keep it anyway cites ${brief}:29, the nearest line.`),
  ).toBeVisible();
  await accessible(page, "a stage's thread with a question that couldn't be kept");
  await thread
    .getByRole("button", {
      name: "Keep it anyway: Does a refused transfer notify the account owner?",
    })
    .click();
  await expect(thread.getByText("1 question couldn't be kept: its line didn't match")).toHaveCount(
    0,
  );
  await expect(
    thread.getByText("Answer: Does a refused transfer notify the account owner?"),
  ).toBeVisible();
});

test("the architect draws a component that doesn't exist yet, and the architecture stage knows it as planned", async ({
  page,
}) => {
  await open(page, app(), `change-diagram?change=${CHANGE}`);
  const form = page.locator(".sketch-panel");
  await form.getByLabel("From component").fill("forge-scheduler");
  await form.getByLabel("A new flow (the component has none fitting, or is new)").check();
  await form.getByLabel("What a person calls the new flow").fill("Reset the daily limits");
  await form.getByLabel("In words").fill("Every night at midnight");
  await form.getByLabel("To component").fill("ledger-api");
  await form
    .getByLabel("Its API (METHOD /path, an Endpoint id, or a topic)")
    .fill("POST /limits/reset");
  await form.getByLabel("The API doesn't exist yet").check();
  await form.getByRole("button", { name: "Preview" }).click();
  await form.getByRole("button", { name: "Draw it" }).click();
  // The next stroke starts clean: "doesn't exist yet" isn't carried over.
  await expect(form.getByLabel("The API doesn't exist yet")).not.toBeChecked();
  await expect(form.getByRole("radio", { name: "A component retired" })).toBeVisible();
  await accessible(page, "the change diagram after a stroke");

  // The drawn target flow, with a deploy order naming the planned repo, passes the stage's checks.
  const flows = join(dir(), "target-flows");
  const drawn = (await readdir(flows)).find((f) => f.startsWith("forge-scheduler."));
  expect(drawn).toBeDefined();
  // The assistant keeps the drawn step and says what it sends, as the stage asks.
  const delta = parse(await readFile(join(flows, drawn!), "utf8")) as {
    steps: Record<string, unknown>[];
  };
  delta.steps[0]!.fields = { returns: ["resetCount"] };
  const answer = stringify({
    flows: [delta],
    deploy: [
      {
        repo: "forge-scheduler",
        why: "The new job deploys first; it calls ledger-api's new reset.",
      },
    ],
  });
  await writeFile(join(app().root, "architecture-answer.yaml"), answer);
  // The feature stage placed the change: the new flow of the planned component.
  await writeFile(
    join(dir(), "feature.yaml"),
    stringify({
      schemaVersion: 1,
      change: CHANGE,
      entry: "brief",
      summary: "A nightly job resets every account's daily transfer limit.",
      newFlows: [
        {
          name: "Reset the daily limits",
          repo: "forge-scheduler",
          why: "Nothing resets the limits today.",
        },
      ],
    }),
  );
  const said = atticus(
    app().root,
    "stage",
    "check",
    CHANGE,
    "architecture",
    "architecture-answer.yaml",
  );
  expect(said).not.toMatch(/forge-scheduler, which isn.t a repo the estate has/);
  expect(said).not.toMatch(/goes to forge-scheduler, which the catalog doesn't have/);
  expect(said).toContain("The stage's checks find nothing to fix: hand the draft in.");
});
