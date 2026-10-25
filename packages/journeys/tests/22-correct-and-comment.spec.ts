import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
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
 * The Map with its evidence and a stage tab's comment box (ADR 0124 addendum D-app, F3 and
 * B10). An architect hovers a contract's citation and reads the quoted line and who checked it,
 * marks the fact wrong from the Map, and gets the git and verify commands; a team lead comments
 * on a critic finding on the Stories tab, and gets the git command and the stage's command. The
 * app writes the files and runs neither. Everything is the invented Forge estate (CLAUDE.md
 * rule 3).
 */

const CHANGE = "add-transfer-limit";
const REL = `openspec/changes/${CHANGE}`;
const AT = "src/main/java/forge/ledger/LedgerEndpoints.java";

let app: App | undefined;
let root = "";
const a = () => {
  if (!app) throw new Error("The journey's app hasn't started.");
  return app;
};
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  root = await forgeMetarepo();
  // The ledger read by an assistant and verified: one fact, on the line the catalog cites.
  await mkdir(join(root, "facts"), { recursive: true });
  await writeFile(
    join(root, "facts/forge-ledger.jsonl"),
    JSON.stringify({
      kind: "entry",
      id: "e-get-balance",
      repo: "forge-ledger",
      commit: "0123abc",
      component: "ledger-api",
      entryType: "rest",
      method: "GET",
      path: "/accounts/{id}/balance",
      cite: {
        file: AT,
        line: 8,
        value: "/accounts/{id}/balance",
        quote: 'get("/accounts/{id}/balance")',
      },
      verified: "line",
      by: "assistant",
      conf: "declared",
    }) + "\n",
  );
  // The stories stage has run, and the plan gate's critic found one thing.
  await mkdir(join(root, REL, "stage"), { recursive: true });
  await writeFile(
    join(root, REL, "stage/stories.yaml"),
    stringify({
      schemaVersion: 1,
      change: CHANGE,
      stage: "stories",
      iteration: 1,
      state: "done",
      updatedAt: "2026-10-24T09:00:00Z",
    }),
  );
  await mkdir(join(root, REL, "review/plan/1"), { recursive: true });
  await writeFile(
    join(root, REL, "review/plan/1/f-0000000a.yaml"),
    stringify({
      schemaVersion: 1,
      id: "f-0000000a",
      kind: "issue",
      change: CHANGE,
      gate: "plan",
      round: 1,
      rule: "review.outcome-has-story",
      layer: "org",
      lens: "complete",
      severity: "risk",
      artifact: "stories.md",
      locator: { line: 4 },
      summary: "The refusal outcome has no story of its own.",
      why: "Every outcome the brief names needs a story that builds it.",
      fix: { text: "Add a story for refusing a transfer over the limit." },
      evidence: [{ source: "artifact", path: "stories.md", line: 4 }],
      waivable: false,
      state: "open",
      createdAt: "2026-10-24T09:00:00Z",
    }),
  );
  app = await startApp(root);
});
test.afterAll(async () => {
  if (app) await stopApp(app);
});

test("a contract's citation shows its quote on focus, and its fact is marked wrong from the Map", async ({
  page,
}) => {
  await open(page, a(), "contracts");
  await page.getByRole("button", { name: /^GET \/accounts\/\{\}\/balance/ }).click();
  const cite = page.getByRole("button", {
    name: `Where this was found: forge-ledger, ${AT}:8`,
  });
  await cite.focus();
  const tip = page.getByRole("tooltip").filter({ hasText: AT });
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('get("/accounts/{id}/balance")');
  await expect(tip).toContainText("checked on its line by atticus verify");
  await accessible(page, "a contract's citation, its tooltip open");
  // Escape hides the tooltip without moving focus (WCAG 1.4.13).
  await page.keyboard.press("Escape");
  await expect(tip).toBeHidden();

  await cite.press("Enter");
  await page.getByRole("button", { name: "Correct the fact GET /accounts/{id}/balance" }).click();
  const form = page.getByRole("form", { name: "Correct GET /accounts/{id}/balance" });
  await form.getByRole("button", { name: "Save the correction" }).click();
  await expect(form.getByRole("alert")).toHaveText("Say why the fact is wrong first.");
  await form
    .getByLabel("Why (required to mark it wrong)")
    .fill("The balance moved to the accounts service last quarter.");
  await form.getByRole("button", { name: "Save the correction" }).click();
  await expect(form.getByRole("status")).toContainText(
    "Written to facts/forge-ledger.corrections.jsonl",
  );
  await expect(form).toContainText("git add facts/forge-ledger.corrections.jsonl && git commit");
  await expect(form).toContainText("atticus verify forge-ledger");
  await accessible(page, "a fact corrected from the Map");
  const line = JSON.parse(
    (await readFile(join(root, "facts/forge-ledger.corrections.jsonl"), "utf8")).trim(),
  ) as { fact: string; action: string; by: string };
  expect(line).toMatchObject({ fact: "e-get-balance", action: "wrong" });
  // The person is the metarepo's Git user (ADR 0073).
  expect(line.by).toBe("priya");
});

test("a finding on the Stories tab takes a comment, written for the stage's next run", async ({
  page,
}) => {
  await open(page, a(), `stories?change=${CHANGE}`);
  const panel = page.locator("section", {
    has: page.getByRole("heading", { name: "What the critic found", level: 2 }),
  });
  await expect(panel).toContainText("The refusal outcome has no story of its own.");
  await expect(panel.getByRole("button", { name: "Make the fix for f-0000000a" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Waive f-0000000a" })).toHaveCount(0);
  await accessible(page, "the Stories tab's findings");
  await panel
    .getByLabel("Your comment on f-0000000a")
    .fill("The refusal is s1's second criterion; keep it there.");
  await panel.getByRole("button", { name: "Save the comment" }).click();
  await expect(panel.getByRole("status").first()).toContainText("Written to questions/");
  await expect(panel).toContainText(`git add questions/`);
  await expect(panel).toContainText(`atticus plan stories ${CHANGE}`);
  await expect(panel).toContainText("not read yet: run the stage");
  await accessible(page, "a comment on a finding");
  const loop = parse(await readFile(join(root, REL, "stage/stories.yaml"), "utf8")) as {
    questions: string[];
  };
  expect(loop.questions).toHaveLength(1);
  const files = await readdir(join(root, "questions"));
  expect(files).toContain(`${loop.questions[0]}.yaml`);
});
