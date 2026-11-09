import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  accessible,
  atticus,
  expect,
  open,
  startApp,
  stopApp,
  test,
  type App,
} from "../support/app.js";

/**
 * ADR 0190: set up from the app, "Edit, then Propose". From an empty folder (a clone of the
 * metarepo's repo the Git host made, a local bare repository here: no network) a person creates
 * the metarepo, adds three repos by pasting their clone URLs, sets the Git host to manual with the
 * metarepo's id, turns AI decides on, and raises a change's hand-off: no YAML edits and no
 * terminal. Everything is invented (CLAUDE.md rule 3).
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const URLS = [
  "https://dev.azure.com/forgeorg/Forge%20Payments/_git/forge-ledger",
  "https://dev.azure.com/forgeorg/Forge%20Payments/_git/forge-cards?path=/src",
  "git@ssh.dev.azure.com:v3/forgeorg/Forge%20Payments/forge-gateway",
];

let app: App;
let parent: string;
const git = (cwd: string, ...a: string[]) =>
  spawnSync(
    "git",
    [
      "-c",
      "user.name=Forge",
      "-c",
      "user.email=forge@example.com",
      "-c",
      "commit.gpgsign=false",
      ...a,
    ],
    { cwd, encoding: "utf8" },
  );

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  parent = await mkdtemp(join(tmpdir(), "atticus-journey-setup-"));
  // The metarepo's repo as the Git host makes it (main with a README), cloned: an empty folder
  // as far as Atticus is concerned.
  git(parent, "init", "-q", "--bare", "-b", "main", "forge-payments-metarepo.git");
  await mkdir(join(parent, "seed"));
  git(join(parent, "seed"), "init", "-q", "-b", "main");
  await writeFile(join(parent, "seed", "README.md"), "# Forge Payments metarepo\n");
  git(join(parent, "seed"), "add", "-A");
  git(join(parent, "seed"), "commit", "-qm", "Initial commit");
  git(join(parent, "seed"), "push", "-q", join(parent, "forge-payments-metarepo.git"), "main");
  git(parent, "clone", "-q", "forge-payments-metarepo.git", "forge-payments-metarepo");
  const root = join(parent, "forge-payments-metarepo");
  git(root, "config", "user.name", "Priya Nair");
  git(root, "config", "user.email", "priya@forge.example");
  app = await startApp(root);
});
test.afterAll(async () => {
  if (app) await stopApp(app);
  await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const pack = (rel: string) => readFile(join(app.root, "org-pack", rel), "utf8");

test("an empty folder: the app offers to create the metarepo here", async ({ page }) => {
  await page.goto(app.url);
  await expect(page.getByRole("heading", { name: "Set up Atticus here", level: 2 })).toBeVisible();
  await expect(page.getByText(/isn't a metarepo yet/)).toBeVisible();
  await accessible(page, "Create the metarepo here");
  await page.getByLabel("Name", { exact: true }).fill("forge-payments");
  await page.getByLabel("Platform", { exact: true }).fill("forge");
  await page.getByLabel("Owner (optional)").fill("priya");
  // Read from the clone's origin.
  await expect(page.getByLabel("The metarepo on your Git host (optional)")).toHaveValue(
    "forge-payments-metarepo",
  );
  await page.getByRole("button", { name: "Create the metarepo" }).click();
  // Home continues with Onboarding.
  await expect(page).toHaveURL(/#\/home$/);
  await expect(page.getByRole("heading", { name: "Set up Atticus here" })).toHaveCount(0);
  const rt = parse(await pack("runtime.yaml")) as { schemaVersion: number; adapters: unknown };
  expect(rt.schemaVersion).toBe(4);
  expect(rt.adapters).toEqual({
    gitHost: { type: "manual", settings: { metarepo: "forge-payments-metarepo" } },
  });
});

test("three repos added by pasting their clone URLs, previewed, then written", async ({ page }) => {
  await open(page, app, "repos");
  await page.getByRole("textbox", { name: "Clone URLs" }).fill(URLS.join("\n"));
  await page.getByRole("button", { name: "Read the list" }).click();
  const table = page.getByRole("table");
  await expect(table.getByText("3 repos to add")).toBeVisible();
  await expect(table.getByText("From: " + URLS[1])).toBeVisible();
  await page.getByRole("button", { name: "Preview the change" }).click();
  await expect(
    page.getByRole("list", {
      name: "Lines that change in org-pack/profiles/forge/repos.manifest.yaml",
    }),
  ).toContainText("+   - id: forge-gateway");
  await accessible(page, "Set up › Repos, the preview");
  await page.getByRole("button", { name: "Write it" }).click();
  await expect(page.getByText(/repos\.manifest\.yaml is written/)).toBeVisible();
  // Then Propose for review, with its own Yes (ADR 0183, 0186).
  await expect(page.getByRole("button", { name: "Propose for review" }).first()).toBeVisible();
  const m = parse(await pack("profiles/forge/repos.manifest.yaml")) as {
    repos: { id: string; url: string }[];
  };
  expect(m.repos.map((r) => r.id)).toEqual(["forge-ledger", "forge-cards", "forge-gateway"]);
  expect(m.repos[1]!.url).toBe("https://dev.azure.com/forgeorg/Forge%20Payments/_git/forge-cards");
  // The list shows them, each with Detect the type.
  await expect(page.getByRole("button", { name: "Detect the type of forge-cards" })).toBeVisible();
});

test("the Git host set to manual with the metarepo's id, in the Adapters panel", async ({
  page,
}) => {
  await open(page, app, "ai");
  const host = page.locator("details", { has: page.locator("summary", { hasText: "Git host" }) });
  await expect(host.getByLabel("Git host: how it is reached")).toHaveValue("manual");
  await host.getByLabel("The metarepo's repo on the Git host").fill("forge-payments-metarepo");
  await host.getByLabel("Protected branches (one a line)").fill("main");
  await host.getByRole("button", { name: "Preview the change" }).click();
  await expect(
    host.getByRole("list", { name: "Lines that change in org-pack/runtime.yaml" }),
  ).toContainText("protectedBranches");
  await accessible(page, "Set up › AI, the Adapters panel");
  await host.getByRole("button", { name: "Write it" }).click();
  await expect(host.getByText(/runtime\.yaml is written/)).toBeVisible();
  const rt = parse(await pack("runtime.yaml")) as { adapters: { gitHost: unknown } };
  expect(rt.adapters.gitHost).toEqual({
    type: "manual",
    settings: { metarepo: "forge-payments-metarepo", protectedBranches: ["main"] },
  });
  // Propose for review: the org pack's files pushed on a branch, its PR a step for the person.
  await host.getByRole("button", { name: "Propose for review" }).click();
  await host.getByRole("button", { name: /^Push \d+ files? and open the PR$/ }).click();
  await expect(host.getByText(/The PR is a step for you on Home/)).toBeVisible();
  const branches = git(join(parent, "forge-payments-metarepo.git"), "branch", "--list").stdout;
  expect(branches).toMatch(/propose\/org-pack\//);
});

test("AI decides turned on in the fresh metarepo, with no upgrade to run", async ({ page }) => {
  await open(page, app, "ai");
  await expect(page.getByRole("heading", { name: "Upgrade this metarepo" })).toHaveCount(0);
  await page.locator("#ai-decide-links").selectOption("auto");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/Saved org-pack\/runtime\.yaml/).first()).toBeVisible();
  const rt = parse(await pack("runtime.yaml")) as {
    schemaVersion: number;
    decide: { links: string };
  };
  expect(rt.schemaVersion).toBe(4);
  expect(rt.decide.links).toBe("auto");
  expect(atticus(app.root, "upgrade", "--check")).toMatch(/Up to date/);
});

test("a change's hand-off raised from the app, on the manual Git host", async ({ page }) => {
  // The change's stages, done with the assistant (what the stage threads write).
  atticus(app.root, "change", "new", "Add note tags", "--type", "feature", "--by", "priya");
  await cp(
    join(FIXTURES, "forge-studio/change/add-note-tags"),
    join(app.root, "openspec/changes/add-note-tags"),
    { recursive: true },
  );
  await open(page, app, "changes/add-note-tags");
  await page.getByRole("button", { name: "Raise hand-off" }).first().click();
  await expect(page.getByText(/Hand-off raised/).first()).toBeVisible();
  // The hand-off's branch is on the metarepo's remote; its PR is a step for the person.
  const branches = git(join(parent, "forge-payments-metarepo.git"), "branch", "--list").stdout;
  expect(branches).toMatch(/handoff\/add-note-tags\/define/);
});
