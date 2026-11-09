import { accessible, expect, forgeJourney, open, test } from "../support/app.js";

/**
 * ADR 0189: Ask Atticus answers a wiki question from the organisation's knowledge, not only the
 * catalog ("How do I request a firewall rule?" said "No record in the catalog is named…"). The
 * passage of inputs/wiki/snow-firewall-request.md is shown with its page, and Knowledge › Search
 * reads inputs/ though it has no snapshot. Everything is the invented Forge estate (rule 3).
 */
const app = forgeJourney();

test("answers how to request a firewall rule from the wiki pages in inputs/", async ({ page }) => {
  await open(page, app(), `explore?ask=${encodeURIComponent("How do I request a firewall rule?")}`);
  const k = page.getByRole("region", { name: "From your organisation's knowledge" }).or(
    page.locator("section", {
      has: page.getByRole("heading", { name: "From your organisation's knowledge" }),
    }),
  );
  await expect(
    k.getByText(/From wiki\/snow-firewall-request\.md \(inputs\)/).first(),
  ).toBeVisible();
  await expect(k.getByText(/atticus knowledge ask/)).toBeVisible();
  await accessible(page, "Ask Atticus, answered from knowledge");
});

test("searches inputs/ with no snapshot taken", async ({ page }) => {
  await open(page, app(), "wiki-search?q=firewall");
  await expect(page.getByText(/No source has a snapshot yet/)).toHaveCount(0);
  await expect(page.getByText(/snow-firewall-request/).first()).toBeVisible();
  await accessible(page, "Knowledge › Search over inputs/");
});
