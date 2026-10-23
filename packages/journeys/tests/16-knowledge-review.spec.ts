import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
 * The knowledge screens end to end against the local API (ADR 0102), as a person with a
 * keyboard uses them: Verify, Correct and Reject an item; Keep a candidate from a saved
 * search; mark a change's needs Done, Not needed and Reopen; and the sources page at phone
 * width. Everything is the invented Forge estate (CLAUDE.md rule 3).
 */

const quote = (page: string, section: string, line: number, text: string) => `quote:
  line: ${line}
  page: ${page}
  section: ${section}
  snapshot: 2026-10-20
  source: forge-eng
  text: ${JSON.stringify(text)}
`;
const evidence = (page: string, line: number) => `evidence:
  - line: ${line}
    path: knowledge/snapshots/forge-eng/2026-10-20/${page}
    side: document
    source: document
`;

const FIREWALL = `schemaVersion: 2
kind: ProcessDefinition
id: firewall-rule-request
status: current
confidence: inferred
alsoOn: []
appliesWhen: A workload needs a firewall rule to reach a host and port.
catalogueItem: Network firewall rule
${evidence("snow-firewall-request.md", 4)}handledBy: Network team
inputs:
  - destination host
  - port
leadTime: 10 working days
processKind: request
${quote("snow-firewall-request.md", "How to request a firewall rule", 4, "Typical lead time: 10 working days.")}steps: []
tags: []
title: Network firewall rule
urls: []
`;
const NORTHWIND = `schemaVersion: 2
kind: Party
id: northwind-pay
status: current
confidence: inferred
aliases: []
alsoOn: []
contacts: []
${evidence("teams.md", 9)}name: Northwind Pay
owner: Payments team
owns:
  - card processing
partyKind: vendor
${quote("teams.md", "Payments team", 9, "The Payments team works with Northwind Pay, the card processor.")}responsibilities: []
systems: []
tags: []
typicalLeadTimes: {}
urls: []
uses: []
`;
const FIND = `schemaVersion: 1
phrase: certificate
at: 2026-10-20T09:00:00Z
matches:
  - source: forge-eng
    page: certificate-renewal.md
    section: Renewing a TLS certificate
    line: 3
    excerpt: Certificates on the Forge gateway expire every 12 months.
candidates:
  - record:
      kind: ProcessDefinition
      schemaVersion: 2
      id: certificate-renewal-request
      status: current
      confidence: inferred
      ${evidence("certificate-renewal.md", 3).replace(/\n/g, "\n      ").trimEnd()}
      flags:
        - found:certificate
      title: Certificate renewal
      processKind: request
      appliesWhen: A certificate on the Forge gateway is due to expire.
      leadTime: 15 working days
      handledBy: Platform security team
      inputs: []
      steps: []
      tags: []
      ${quote("certificate-renewal.md", "Renewing a TLS certificate", 3, "Certificates on the Forge gateway expire every 12 months.").replace(/\n/g, "\n      ").trimEnd()}
      alsoOn: []
      urls: []
`;
const NEEDS = `schemaVersion: 1
change: add-transfer-limit
updatedAt: 2026-10-20T09:00:00Z
needs:
  - item: firewall-rule-request
    kind: request
    title: Network firewall rule
    for: change
    why: The ledger calls Northwind Pay through a new route.
    from: assistant
    leadTime: 10 working days
    handledBy: Network team
    status: open
  - item: northwind-pay
    kind: vendor
    title: Northwind Pay
    for: change
    why: The limit check asks the card processor.
    from: assistant
    status: open
`;

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
  await put("knowledge/items/processdefinition/firewall-rule-request.yaml", FIREWALL);
  await put("knowledge/items/party/northwind-pay.yaml", NORTHWIND);
  await put("knowledge/finds/certificate.yaml", FIND);
  await put("openspec/changes/add-transfer-limit/needs.yaml", NEEDS);
  app = await startApp(root);
});
test.afterAll(async () => {
  if (app) await stopApp(app);
});

test("Verify, Correct and Reject keep the keyboard on the item", async ({ page }) => {
  await open(page, a(), "knowledge?item=firewall-rule-request");
  const detail = page.locator("section[aria-labelledby=item-detail]");
  await detail.getByRole("button", { name: "Correct" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#fix-firewall-rule-request-title")).toBeFocused();
  await accessible(page, "correcting an item");
  await detail.getByRole("button", { name: "Cancel" }).click();
  await expect(detail.getByRole("button", { name: "Correct" })).toBeFocused();

  await detail.getByRole("button", { name: "Verify" }).click();
  await expect(detail.locator(".chip.done").first()).toContainText("Verified by");
  await expect(detail.getByRole("status")).toContainText("Verified firewall-rule-request");
  await expect(detail.getByRole("button", { name: "Verify" })).toBeFocused();

  await detail.getByRole("button", { name: "Reject" }).click();
  await expect(page.locator("#reject-why")).toBeFocused();
  await detail.getByRole("button", { name: "Reject it" }).click();
  await expect(detail.getByRole("alert")).toHaveText("Say why it is wrong.");
  await page.keyboard.type("The page was replaced last month.");
  await detail.getByRole("button", { name: "Reject it" }).click();
  await expect(detail.locator(".chip.blocking").first()).toContainText("Rejected by");
  await expect(detail).toContainText("The page was replaced last month.");
  await expect(detail.getByRole("button", { name: "Reject", exact: true })).toBeFocused();

  // The note was about that item: another item doesn't carry it.
  await page.getByRole("link", { name: "Northwind Pay" }).click();
  await expect(detail.getByRole("heading", { name: "Northwind Pay", level: 3 })).toBeVisible();
  await expect(detail.getByRole("status")).toHaveCount(0);
});

test("an item the address names that isn't there says so", async ({ page }) => {
  await open(page, a(), "knowledge?item=no-such-item");
  await expect(page.getByText(/There is no knowledge item no-such-item/)).toBeVisible();
});

test("Keep from a saved search, and the search typed stays on screen", async ({ page }) => {
  await open(page, a(), "wiki-search?q=gateway");
  await page.getByRole("link", { name: "certificate", exact: true }).click();
  await expect(page).toHaveURL(/#\/wiki-search\?q=gateway&find=certificate$/);
  await expect(page.getByLabel("A term or phrase")).toHaveValue("gateway");
  const keep = page.getByRole("button", { name: "Keep Certificate renewal" });
  await expect(keep).toBeVisible();
  await accessible(page, "a saved search");
  await keep.click();
  await expect(page.getByText(/Kept as a Request by/)).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Kept certificate-renewal-request" }),
  ).toBeVisible();
  await expect(page.locator("li").filter({ hasText: "Certificate renewal" })).toBeFocused();
});

test("a change's needs: Done, Not needed and Reopen, each named for its need", async ({ page }) => {
  await open(page, a(), "feature-design?change=add-transfer-limit");
  const needs = page.locator("section[aria-labelledby=needs-add-transfer-limit]");
  await expect(needs).toContainText("2 OPEN", { ignoreCase: true });
  // The firewall item was rejected above: the need says so.
  await expect(needs.locator(".chip.blocking").first()).toContainText("Rejected by");

  await needs.getByRole("button", { name: "Done: Network firewall rule" }).click();
  await expect(page.locator("#need-firewall-rule-request-change-note")).toBeFocused();
  await page.keyboard.type("CTASK0010001");
  await page.keyboard.press("Enter");
  await expect(needs.getByRole("status")).toContainText("Network firewall rule is done");
  await expect(needs).toContainText("Done by");
  await expect(page.locator("#need-firewall-rule-request-change-t")).toBeFocused();

  await needs.getByRole("button", { name: "Not needed: Northwind Pay" }).click();
  await needs.getByRole("button", { name: "Save" }).click();
  await expect(needs.getByRole("alert")).toHaveText("Say why it isn't needed.");
  await page.keyboard.type("The gateway already asks it.");
  await needs.getByRole("button", { name: "Save" }).click();
  await expect(needs).toContainText("Not needed (");
  await expect(needs).toContainText("0 OPEN", { ignoreCase: true });

  await needs.getByRole("button", { name: "Reopen: Network firewall rule" }).click();
  await expect(needs.getByRole("status")).toContainText("Network firewall rule is open again");
  await expect(needs).toContainText("1 OPEN", { ignoreCase: true });
  await accessible(page, "a change's needs");
});

test("at phone width the knowledge screens don't scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  for (const route of ["knowledge?item=northwind-pay", "wiki-search?find=certificate", "wikis"]) {
    await open(page, a(), route);
    // A string, so this file needs no DOM types: the page's own width against its window's.
    const over = await page.evaluate<number>(
      "document.documentElement.scrollWidth - document.documentElement.clientWidth",
    );
    expect(over, `${route} scrolls sideways`).toBeLessThanOrEqual(0);
  }
  // A source never synced says so, not that its snapshot is too old.
  await expect(
    page.getByText("Not synced yet: sync it so the knowledge scan can read it"),
  ).toBeVisible();
});
