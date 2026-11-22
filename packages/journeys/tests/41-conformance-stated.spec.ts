import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { accessible, expect, forgeJourney, open, test } from "../support/app.js";

/**
 * ADR 0206, the review's point 9: the Code against design screen's Stated section, with a claim
 * of each of the five outcomes (its cite, where it is stated, what to do next and its finding),
 * passes WCAG 2.1 AA (axe: no moderate, serious or critical violation). On the field-shaped
 * estate's quick change, publish-settled-refunds, with a stored check of forge-svc-01's branch
 * written here as `atticus change conform` keeps it. Everything is invented.
 */

const app = forgeJourney({ estate: "field" });
const CHANGE = "publish-settled-refunds";
const REPO = "forge-svc-01";
const TOPIC = "forge.items.settled";

const claim = (outcome: string, check: string, line: number, what: string, extra = {}) => ({
  outcome,
  check,
  repo: REPO,
  from: { file: "design.md", line, task: "e2" },
  expected: `topic ${TOPIC}`,
  what,
  at: [{ source: "artifact", path: "design.md", line }],
  next: `Then check again: atticus change conform ${CHANGE}.`,
  ...extra,
});

test("the Stated section: each outcome with its cite and next step, accessibly", async ({
  page,
}) => {
  const dir = join(app().root, "openspec/changes", CHANGE, "conform");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${REPO}.yaml`),
    JSON.stringify({
      schemaVersion: 1,
      change: CHANGE,
      repo: REPO,
      ref: `change/${CHANGE}`,
      commit: "c".repeat(40),
      base: "a".repeat(40),
      checkedAt: "2026-11-22T09:00:00Z",
      counts: {
        found: 0,
        missing: 0,
        stillThere: 0,
        unexpected: 0,
        claims: { present: 1, differs: 1, missing: 1, notCheckable: 1, unconfirmed: 1 },
      },
      items: [],
      unchecked: [],
      claims: [
        claim("present", "publish", 14, `${REPO} publishes to ${TOPIC}.`, {
          at: [{ source: "code", repo: REPO, path: "src/RefundEvents.java", line: 4 }],
          why: "The call's target is settled by the map's join, not by this fact.",
          next: "Nothing: the line is cited for the reviewer.",
        }),
        claim(
          "present-differently",
          "config",
          15,
          `${REPO} sets refunds.retry.max in prod to 3, not 5.`,
          {
            expected: "key refunds.retry.max, env prod, value 5",
            found: "key refunds.retry.max, env prod, value 3",
          },
        ),
        claim("missing", "endpoint", 16, `${REPO} serves no GET /v1/refunds/{id}.`, {
          expected: "GET /v1/refunds/{id}",
        }),
        claim(
          "not-checkable",
          "other",
          17,
          `The design says a person checks this in ${REPO}: Refunds are kept for seven years.`,
          { expected: "Refunds are kept for seven years." },
        ),
        claim(
          "unconfirmed",
          "listener",
          18,
          `Atticus couldn't confirm that ${REPO} listens to ${TOPIC}: nobody has read ${REPO} at this commit.`,
        ),
      ],
      problems: [],
    }),
  );
  await open(page, app(), `conformance?change=${CHANGE}`);
  await expect(page.getByRole("heading", { name: "Stated in the design" })).toBeVisible();
  const table = page.getByRole("table", { name: "Stated in the design" });
  await expect(table).toBeVisible();
  for (const o of [
    "Present",
    "Present differently",
    "Missing",
    "Not checkable",
    "Couldn't confirm",
  ])
    await expect(table.getByRole("cell", { name: o, exact: true })).toBeVisible();
  await accessible(page, "Code against design: the Stated section");
});
