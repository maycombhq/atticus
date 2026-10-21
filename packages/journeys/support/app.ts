import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../..");
const FIXTURES = join(REPO, "fixtures");
const BIN = join(REPO, "packages/cli/dist/bin.js");

/** Run the atticus command line against a metarepo, as a person would from a terminal. */
export function atticus(root: string, ...args: string[]): string {
  const r = spawnSync(process.execPath, [BIN, ...args, "--root", root], {
    encoding: "utf8",
    env: { ...process.env, ATTICUS_RUNTIME: "hand-off" },
  });
  return `${r.stdout}${r.stderr}`;
}

/**
 * The Forge estate as a team has it after its first weeks: the org pack, the scanned catalog,
 * the diagrams and partner specs dropped into inputs/, the seeded change and an initiative.
 * Everything is invented (CLAUDE.md rule 3).
 */
export async function forgeMetarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-journey-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  await cp(join(FIXTURES, "forge-change/openspec"), join(root, "openspec"), { recursive: true });
  await cp(join(FIXTURES, "forge/inputs"), join(root, "inputs"), { recursive: true });
  const rows = parse(readFileSync(join(FIXTURES, "forge/expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[];
  for (const r of rows) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) continue;
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  atticus(
    root,
    "initiative",
    "new",
    "Transfer limits rollout",
    "--journey",
    "new-feature",
    "--by",
    "tom",
    "--release",
    "2026-12-15",
  );
  atticus(
    root,
    "initiative",
    "plan",
    "transfer-limits-rollout",
    "--target",
    "ledger",
    "--by",
    "tom",
  );
  const git = (...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  // The person using the app is the metarepo's Git user (ADR 0073).
  git("config", "user.name", "Priya Nair");
  git("config", "user.email", "priya@forge.example");
  git("-c", "user.name=Forge", "-c", "user.email=forge@example.com", "add", "-A");
  git(
    "-c",
    "user.name=Forge",
    "-c",
    "user.email=forge@example.com",
    "commit",
    "-qm",
    "Forge metarepo",
  );
  return root;
}

export interface App {
  url: string;
  root: string;
  server: ChildProcess;
}

/** Start `atticus ui` on a free port and wait for its address. */
export async function startApp(root: string): Promise<App> {
  const server = spawn(process.execPath, [BIN, "ui", "--port", "0", "--root", root], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = await new Promise<string>((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`atticus ui didn't start: ${out}`)), 30_000);
    server.stdout!.on("data", (b: Buffer) => {
      out += b.toString();
      const m = /running at (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) {
        clearTimeout(t);
        resolve(m[1]!);
      }
    });
    server.stderr!.on("data", (b: Buffer) => (out += b.toString()));
    server.on("exit", (c) => reject(new Error(`atticus ui exited ${c}: ${out}`)));
  });
  return { url, root, server };
}

export async function stopApp(a: App): Promise<void> {
  // Wait for the server to exit: until then it may still be writing its log.
  if (a.server.exitCode === null && a.server.signalCode === null) {
    const exited = new Promise((resolve) => a.server.once("exit", resolve));
    a.server.kill();
    await exited;
  }
  await rm(a.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// ------------------------------------------------------------------ page helpers

/** Go to a screen by its route and wait for its first panel. */
export async function open(page: Page, app: App, route: string): Promise<void> {
  await page.goto(`${app.url}/#/${route}`);
  await expect(page.locator(".panel").first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  await skipTour(page);
}

/** Each test is a fresh browser, so the first-run tour opens again: skip it. */
async function skipTour(page: Page): Promise<void> {
  const skip = page.getByRole("button", { name: "Skip the tour" });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

/** WCAG 2.1 AA: no serious or critical axe violation on the page as it is now. */
export async function accessible(page: Page, where: string): Promise<void> {
  const r = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const bad = r.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help} — ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(" "))
          .join(" | ")}`,
    );
  expect(bad, `accessibility on ${where}`).toEqual([]);
}

/**
 * A fresh Forge metarepo and its own server for one journey (one test file): its steps run in
 * order and share the state they build, and no journey sees another's.
 */
export function forgeJourney(): () => App {
  let app: App | undefined;
  test.describe.configure({ mode: "serial" });
  test.beforeAll(async () => {
    app = await startApp(await forgeMetarepo());
  });
  test.afterAll(async () => {
    if (app) await stopApp(app);
  });
  return () => {
    if (!app) throw new Error("The journey's app hasn't started.");
    return app;
  };
}

export { expect, test };
