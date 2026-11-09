import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { accessible, expect, forgeJourney, open, test } from "../support/app.js";

/**
 * ADR 0189, "the BA shapes, the AI re-checks": on the Stories tab the business analyst renames a
 * story and splits another in plain words. A rename keeps the number; the split's new part takes
 * the next free one at once, reserved in stage/stories-numbers.yaml. Each waits for the next draft,
 * which maps the tasks to the stories (that mapping and the coverage check are tested over a real
 * draft in packages/planner/test/story-shape.test.ts: this fixture has no target flows to draft
 * from). The stories reach the work tracker as manual steps, each id kept. Invented Forge names.
 */
const app = forgeJourney();
const DIR = () => join(app().root, "openspec/changes/add-transfer-limit");

test.beforeAll(async () => {
  // The numbers a draft of these stories kept (review round 50).
  await mkdir(join(DIR(), "stage"), { recursive: true });
  await writeFile(
    join(DIR(), "stage/stories-numbers.yaml"),
    stringify({
      schemaVersion: 1,
      repos: { "forge-ledger": 1, "forge-portal-bff": 2, "forge-portal-ui": 3 },
      steps: {},
      stories: [
        { repo: "forge-ledger", flow: "ledger.transfer", id: "s1-refuse-over-limit", tasks: [] },
        { repo: "forge-portal-bff", flow: "portal.limit", id: "s2-show-remaining", tasks: [] },
        { repo: "forge-portal-bff", flow: "portal.audit", id: "s3-audit-refusals", tasks: [] },
        { repo: "forge-ledger", flow: "ledger.velocity", id: "s4-velocity-check", tasks: [] },
      ],
    }),
  );
  // Manual work tracker (Azure DevOps by hand).
  const runtime = join(app().root, "org-pack/runtime.yaml");
  const text = await readFile(runtime, "utf8");
  await writeFile(
    runtime,
    text.replace("workTracker: { type: mock }", "workTracker: { type: manual }"),
  );
});

test("renames a story and splits another in plain words, numbers kept", async ({ page }) => {
  await open(page, app(), "stories?change=add-transfer-limit");
  const shape = page
    .getByRole("region", { name: "Shape the stories" })
    .or(page.locator(".panel", { has: page.getByText("Shape the stories", { exact: true }) }));
  await expect(shape.getByText(/Nothing shaped yet/)).toBeVisible();
  // Rename s1.
  await shape.getByLabel("Rename a story").check();
  await shape.getByLabel("Story", { exact: true }).selectOption("s1-refuse-over-limit");
  await shape.getByLabel("Its name").fill("Stop a transfer over today's limit");
  await shape.getByRole("button", { name: "Save" }).click();
  await expect(
    shape.getByText('Rename s1-refuse-over-limit to "Stop a transfer over today\'s limit"'),
  ).toBeVisible();
  // Split s2: the new part is s5, the next free number.
  await shape.getByLabel("Split a story").check();
  await shape.getByLabel("Story", { exact: true }).selectOption("s2-show-remaining");
  await shape.getByLabel("The first part's name").fill("Show what is left today");
  await shape.getByLabel("The other part's name").fill("Warn near the limit");
  await shape.getByRole("button", { name: "Save" }).click();
  await expect(
    shape.getByText(
      /Split s2-show-remaining into "Show what is left today", s5-warn-near-the-limit "Warn near the limit"/,
    ),
  ).toBeVisible();
  await expect(shape.getByText("waits for the next draft")).toHaveCount(2);
  const numbers = parse(await readFile(join(DIR(), "stage/stories-numbers.yaml"), "utf8")) as {
    stories: { id: string }[];
  };
  expect(numbers.stories.map((s) => s.id)).toContain("s5-warn-near-the-limit");
  // One taken back before a draft read it.
  await shape.getByRole("button", { name: /Take back: Rename s1-refuse-over-limit/ }).click();
  await expect(shape.getByText("waits for the next draft")).toHaveCount(1);
  await accessible(page, "the Stories tab, shaped");
});

test("puts the stories in the work tracker as manual steps, with the ids kept", async ({
  page,
}) => {
  await open(page, app(), "stories?change=add-transfer-limit");
  const items = page.locator(".panel", {
    has: page.getByText("Work items in the tracker", { exact: true }),
  });
  await expect(items.getByText(/each work item is a step on Home › Manual steps/)).toBeVisible();
  await expect(items.getByText("Story: Refuse transfers over the daily limit")).toBeVisible();
  await items.getByRole("button", { name: "Put them in the work tracker" }).click();
  await expect(items.getByText(/a step for you \(Home › Manual steps\)/).first()).toBeVisible();
  await expect(items.getByText("step waiting on you").first()).toBeVisible();
  const sync = parse(await readFile(join(DIR(), "sync.yaml"), "utf8")) as {
    workItems: { key: string; id: string }[];
  };
  expect(sync.workItems.find((w) => w.key === "story:s1-refuse-over-limit")?.id).toMatch(
    /^manual:/,
  );
  // Nothing left to put in: no second item is made.
  await expect(items.getByRole("button", { name: "Put them in the work tracker" })).toHaveCount(0);
  await accessible(page, "the plan's work items");
});
