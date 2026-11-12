import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { accessible, atticus, expect, forgeJourney, open, test } from "../support/app.js";

/**
 * ADR 0189: a change goes product owner → architect → business analyst → tech lead. A business
 * question the feature stage raised reaches the product owner after the architect sends it there;
 * a new change's owners are suggested from roles.yaml and accepted with one click; At a glance
 * names whom the change waits on. Everything is the invented Forge estate (CLAUDE.md rule 3).
 */
const app = forgeJourney();

const QUESTION = "q-0189abcdef01";

test.beforeAll(async () => {
  const root = app().root;
  // roles.yaml version 3: the ledger team's architect and tech lead, the organisation's BA.
  await writeFile(
    join(root, "org-pack/roles.yaml"),
    stringify({
      schemaVersion: 3,
      teams: [
        {
          id: "team-ledger",
          name: "Ledger team",
          people: ["ari", "tia"],
          roles: { architect: ["ari"], "team-lead": ["tia"] },
        },
      ],
      defaults: { "business-analyst": ["bao"] },
    }),
  );
  atticus(
    root,
    "change",
    "new",
    "Ledger holds",
    "--type",
    "feature",
    "--id",
    "add-ledger-holds",
    "--owner",
    "product-owner=priya",
    "--system",
    "ledger",
    "--by",
    "priya",
  );
  // The feature stage asked a business question; the stage's role made it the architect's.
  await mkdir(join(root, "questions"), { recursive: true });
  await writeFile(
    join(root, "questions", `${QUESTION}.yaml`),
    stringify({
      schemaVersion: 5,
      id: QUESTION,
      askedBy: {
        step: "change-feature",
        command: "atticus change feature add-ledger-holds",
        at: "2026-11-09T09:00:00Z",
      },
      repo: "add-ledger-holds",
      question: "What happens when the account has too little money on the day?",
      options: [],
      evidence: ["openspec/changes/add-ledger-holds/brief.md:1"],
      scope: { level: "repo", id: "add-ledger-holds" },
      role: "architecture",
      state: "open",
      rerun: "atticus change feature add-ledger-holds",
    }),
  );
});

test("suggests the change's owners from roles.yaml, each accepted with one click", async ({
  page,
}) => {
  await open(page, app(), "changes/add-ledger-holds");
  const owners = page.getByRole("region", { name: "Who is on this change" });
  await expect(owners.getByText("Ledger team, which owns forge-ledger").first()).toBeVisible();
  // One Save at a time: the form opens on Change who is on it.
  await expect(page.getByRole("button", { name: "Save who is on it" })).toHaveCount(0);
  await owners.getByRole("button", { name: "Accept ari as architect" }).click();
  await expect(page.getByText("ari is the architect on this change now.")).toBeVisible();
  await owners.getByRole("button", { name: "Accept bao as business analyst" }).click();
  await expect(page.getByText("bao is the business analyst on this change now.")).toBeVisible();
  await accessible(page, "a change's owners, suggested");
});

test("the architect sends a business question to the product owner", async ({ page }) => {
  await open(page, app(), `questions/${QUESTION}?change=add-ledger-holds`);
  await expect(
    page.getByRole("heading", { name: /too little money on the day/ }).first(),
  ).toBeVisible();
  await expect(page.getByText(/For the architect/).first()).toBeVisible();
  await page.getByLabel("Send it to").selectOption({ label: "the product owner" });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/Sent to the product owner/)).toBeVisible();
  await expect(page.getByText(/Moved from the architect by priya/)).toBeVisible();
  await accessible(page, "a question sent to another role");
});

test("At a glance names whom the change waits on", async ({ page }) => {
  // Define: the product owner's.
  await open(page, app(), "cockpit?change=add-ledger-holds");
  await expect(page.getByText("Waits on: @priya (product owner)")).toBeVisible();
  // The seeded change is in Plan with stories a person wrote (beta.27 review: the stories
  // stage's work, done by hand): the plan hand-off is next, the tech lead's.
  await open(page, app(), "cockpit?change=add-transfer-limit");
  await expect(page.getByText("Waits on: @tia (tech lead)")).toBeVisible();
  await accessible(page, "At a glance, waits on");
});
