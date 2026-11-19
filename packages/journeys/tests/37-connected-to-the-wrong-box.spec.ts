import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accessible, expect, open, reconnectJourney, test } from "../support/app.js";

/**
 * Beta.30 (the owner's field report: "the map shows a connection to the wrong repo; when I try
 * to reconnect it with the actual one it refuses, saying 0 calls to pair, because the calls are
 * paired with the first, wrong repo"). On the invented estate of fixtures/reconnect, forge-orders
 * has an arrow to forge-billing, the wrong box: four of its calls go there (one by its address,
 * one by the assistant's fact, one through a gateway, one sam paired). The person connects
 * forge-orders to forge-ledger, sees those calls listed first with where each goes today and how
 * that was decided, ticks them, says why for the three the code names, says yes to replacing
 * sam's pairing, moves them, applies, and the map draws forge-orders → forge-ledger and no
 * forge-orders → forge-billing. Then Undo, with its removals confirmed (a pairing taken back
 * counts toward the limits), puts the arrow back. No network; nothing is committed or pushed.
 */
const app = reconnectJourney();

// An arrow from forge-orders (its system's box, or its repo's once the system is opened), by
// what the canvas says of it: "repo:forge-orders 4 × calls · paired by a person system:forge-ledger".
const arrow = (to: string) =>
  `.react-flow__edge[aria-label*=":forge-orders "][aria-label$="system:${to}"]`;
const WRONG = arrow("forge-billing");
const RIGHT = arrow("forge-ledger");
const NAMED = ["GET /holds/{id}", "POST /holds/{id}/release", "GET /billing/v1/statements/{id}"];
const WHY = "Ledger serves these since the split from billing.";

test("a call joined to the wrong box is moved to the right one from Connect", async ({ page }) => {
  const root = app().root;
  await open(page, app(), "canvas");
  // The wrong arrow is on the map, and there is none to the right box.
  await expect(page.locator(WRONG)).toHaveAttribute("aria-label", /4 × calls/);
  await expect(page.locator(RIGHT)).toHaveCount(0);

  // Connect forge-orders to forge-ledger, from the repo's box.
  await page.locator('.react-flow__node[data-id="system:forge-orders"]').click();
  await page.getByRole("button", { name: "Open here" }).click();
  // The canvas lays the opened system out first: pick the repo's box once it has settled.
  const connect = page.getByRole("button", { name: "Connect to…" });
  await expect(async () => {
    await page.locator('.react-flow__node[data-id="repo:forge-orders"]').click({ timeout: 2_000 });
    await expect(connect).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await connect.click();
  await page.getByLabel("The other box").selectOption({ label: "repo: forge-ledger" });
  const panel = page.locator(".connect-panel");

  // The calls that go to another box are listed first, with where each goes and how that was
  // decided; it never says there is nothing to pair.
  await expect(
    panel.getByText(
      "5 calls of forge-orders go to another box today: forge-billing (4), northwind-pay (1).",
    ),
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    panel.getByText(
      "goes to forge-billing today: matched by its address (its line names billing.forge.example)",
    ),
  ).toBeVisible();
  await expect(
    panel.getByText(
      "goes to forge-billing today: read from code (the call's fact names forge-billing)",
    ),
  ).toBeVisible();
  await expect(
    panel.getByText(
      "goes to forge-billing today: it goes through forge_billing_1-0, a gateway whose route forwards it there",
    ),
  ).toBeVisible();
  await expect(
    panel.getByText("goes to forge-billing today: paired by sam on 2026-11-10"),
  ).toBeVisible();
  await expect(panel.getByText("nothing is loose")).toHaveCount(0);
  // None is ticked for the person, and the move waits for a tick.
  const move = panel.getByRole("button", { name: "Move to forge-ledger" });
  for (const c of [...NAMED, "GET /entries/{id}", "POST /charges"])
    await expect(
      panel.getByRole("checkbox", { name: `Move ${c} to forge-ledger` }),
    ).not.toBeChecked();
  await expect(move).toBeDisabled();

  // Tick the four that go to forge-billing. Three are named by the code: each asks why.
  for (const c of [...NAMED, "GET /entries/{id}"])
    await panel.getByRole("checkbox", { name: `Move ${c} to forge-ledger` }).check();
  await expect(move).toBeDisabled();
  await expect(panel.getByText(/overrides what the code says/).first()).toBeVisible();
  for (const c of NAMED)
    await panel.getByRole("textbox", { name: `Why ${c} doesn't go where its line says` }).fill(WHY);
  // sam's pairing is replaced only on a yes.
  await expect(move).toBeDisabled();
  await panel.getByRole("checkbox", { name: "Replace sam's pairing of GET /entries/{id}" }).check();
  await expect(move).toBeEnabled();
  await accessible(page, "Connect, with calls to move ticked");

  // Move to forge-ledger: the preview says exactly what changes, and nothing is written yet.
  await move.click();
  const confirm = panel.getByRole("button", { name: "Move 4 calls to forge-ledger" });
  await expect(confirm).toBeEnabled({ timeout: 90_000 });
  for (const c of [
    "GET /holds/{}",
    "POST /holds/{}/release",
    "GET /statements/{}",
    "GET /entries/{}",
  ])
    await expect(
      panel.getByText(
        `forge-orders → forge-billing ${c}: moves from forge-billing to forge-ledger`,
      ),
    ).toBeVisible();
  await expect(panel.getByText(/Apply will refuse/)).toHaveCount(0);
  await expect(panel.getByText(/Apply will wait for you to confirm/)).toHaveCount(0);
  const file = join(root, "facts", "forge-orders.corrections.jsonl");
  expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);

  // Confirmed: four pairings, the person's word with their reason, written and applied in one
  // job (ADR 0204 decision 2); the facts are as read.
  await confirm.click();
  await expect(
    panel.getByText("Connected: forge-orders → forge-ledger is on the map."),
  ).toBeVisible({
    timeout: 120_000,
  });
  const lines = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { by: string; reason?: string; link: { repo: string } });
  expect(lines.slice(1).map((l) => [l.by, l.link.repo])).toEqual(
    Array(4).fill(["priya", "forge-ledger"]),
  );
  expect(lines.filter((l) => l.reason === WHY)).toHaveLength(3);
  expect(readFileSync(join(root, "facts", "forge-orders.jsonl"), "utf8")).toContain(
    '"to":"forge-billing"',
  );
  // The map is redrawn with no Apply to press and no removal to confirm.
  await expect(page.locator(RIGHT)).toHaveAttribute(
    "aria-label",
    /4 × calls · paired by a person/,
    { timeout: 120_000 },
  );
  await expect(page.locator(WRONG)).toHaveCount(0);
  await expect(page.getByText(/waits for you/)).toHaveCount(0);
  // The panel now says they are paired with forge-ledger and drawn, and which go against the code.
  await expect(
    panel.getByText(
      "3 of them go against what the code names (forge-billing (2), forge_billing_1-0 (1)).",
      { exact: false },
    ),
  ).toBeVisible({ timeout: 60_000 });
  await accessible(page, "the map after the move");

  // Undo takes the four lines back in one job. A pairing taken back counts toward the removal
  // limits (ADR 0195's addendum of 2026-11-19): three of forge-orders's 13 records is over a
  // tenth, so the build waits for the person's count, each removal listed with why.
  await panel.getByRole("button", { name: "Undo" }).click();
  await expect(
    panel.getByText(
      "Undone: what this wrote is taken back. The map is built again once you confirm the records it would remove: what is taken back counts toward the removal limits.",
    ),
  ).toBeVisible({ timeout: 120_000 });
  expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
  await expect(page.locator(RIGHT)).toHaveAttribute("aria-label", /paired by a person/);
  await accessible(page, "Connect after Undo, the build waiting");
  await panel.getByRole("link", { name: /^Review the \d+ removals?$/ }).click();
  await expect(page).toHaveURL(/#\/catalog-builds$/);
  const review = page.getByRole("button", { name: /^Review the \d+ removals$/ });
  const n = Number(/\d+/.exec((await review.textContent()) ?? "")![0]);
  await review.click();
  const dialog = page.getByRole("dialog", { name: `Confirm ${n} removals` });
  await expect(
    dialog.getByRole("row").filter({ hasText: "its call goes to forge-billing now" }),
  ).toHaveCount(3);
  await dialog.getByLabel(`Type ${n} to confirm exactly these`).fill(String(n));
  await dialog.getByRole("button", { name: `Remove ${n} records` }).click();
  await expect(dialog).toBeHidden({ timeout: 120_000 });
  // Confirmed: the arrow is back where it was.
  await open(page, app(), "canvas");
  await expect(page.locator(WRONG)).toHaveAttribute("aria-label", /4 × calls/, {
    timeout: 120_000,
  });
  await expect(page.locator(RIGHT)).toHaveCount(0);
  await accessible(page, "the map after Undo, confirmed");
});
