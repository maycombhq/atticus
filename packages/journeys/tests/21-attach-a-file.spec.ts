import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
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
 * Attach a file to a change (ADR 0113): on the change's page and on the Feature page, a person
 * picks a spec; the local API copies it into the change's inputs/ (as atticus change attach
 * does), and the list says what it is and who attached it. The same bytes again are refused with
 * why. A small change's next step is the fast path's one step. Everything is the invented Forge
 * estate (CLAUDE.md rule 3).
 */

let app: App | undefined;
let root = "";
const a = () => {
  if (!app) throw new Error("The journey's app hasn't started.");
  return app;
};
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  root = await forgeMetarepo();
  atticus(
    root,
    "change",
    "new",
    "Show the transfer time",
    "--type",
    "small-change",
    "--id",
    "show-transfer-time",
    "--by",
    "tom",
  );
  app = await startApp(root);
});
test.afterAll(async () => {
  if (app) await stopApp(app);
});

const SPEC = {
  name: "limits-note.md",
  mimeType: "text/markdown",
  buffer: Buffer.from("# Limits\n\nA transfer over 10,000 needs a second approver.\n"),
};

test("a change's page attaches a file, lists it, and refuses the same bytes again", async ({
  page,
}) => {
  await open(page, a(), "changes/add-transfer-limit");
  const panel = page.locator("section", {
    has: page.getByRole("heading", { name: "Files attached", level: 2 }),
  });
  await expect(panel).toContainText("No file is attached yet.");
  await accessible(page, "a change's files, none yet");
  const picker = panel.getByLabel("Attach a file");
  await picker.setInputFiles(SPEC);
  await expect(panel.getByRole("status")).toHaveText(
    "Attached limits-note.md. The change's steps read it from now on.",
  );
  await expect(panel.getByRole("table")).toContainText("inputs/limits-note.md");
  await expect(panel.getByRole("table")).toContainText("Read, cited by line");
  await accessible(page, "a change's files, one attached");
  const index = parse(
    await readFile(join(root, "openspec/changes/add-transfer-limit/inputs/index.yaml"), "utf8"),
  ) as { files: { path: string; addedBy: string }[] };
  expect(index.files.map((f) => f.path)).toEqual(["inputs/limits-note.md"]);

  await picker.setInputFiles({ ...SPEC, name: "copy.md" });
  await expect(panel.getByRole("alert")).toHaveText(
    "It is already attached as inputs/limits-note.md.",
  );
});

test("the Feature page has the same control, and a small change's step is the fast path", async ({
  page,
}) => {
  await open(page, a(), "feature-design?change=show-transfer-time");
  await expect(page.getByRole("heading", { name: "Files attached", level: 2 })).toBeVisible();
  await expect(page.getByText("atticus change small show-transfer-time").first()).toBeVisible();
  await expect(page.getByText("/atticus-small show-transfer-time").first()).toBeVisible();
  await accessible(page, "the Feature page of a small change");
});
