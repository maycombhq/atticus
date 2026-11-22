import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test as base, type Page } from "@playwright/test";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";

/**
 * ADR 0194: the journeys walk the pages with the IDE layout's side panel hidden (until a step
 * shows it), so the Explorer's own names (its changes, systems and filter) don't stand beside
 * the page's; 34-ide-shell walks the Explorer with it shown (`test.use({ sideHidden: false })`).
 */
const test = base.extend<{ sideHidden: boolean }>({
  sideHidden: [true, { option: true }],
  page: async ({ page, sideHidden }, use) => {
    if (sideHidden)
      await page.addInitScript(() => {
        try {
          if (!localStorage.getItem("atticus.shell.side"))
            localStorage.setItem(
              "atticus.shell.side",
              JSON.stringify({ width: 260, hidden: true }),
            );
        } catch {
          // No storage: the panel shows.
        }
      });
    await use(page);
  },
});

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../..");
const FIXTURES = join(REPO, "fixtures");
const BIN = join(REPO, "packages/cli/dist/bin.js");

/**
 * Every file of a metarepo's catalog/generated with its bytes: what a journey compares to say a
 * scan that wrote nothing left the catalog as it was (beta.26 safety stop).
 */
export function catalogFiles(root: string): Record<string, string> {
  const dir = join(root, "catalog", "generated");
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      // Keyed "/"-separated on every OS (`table/x.yaml`), as the app names catalog files.
      else out[relative(dir, p).split(sep).join("/")] = readFileSync(p, "utf8");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

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
  // Beta.26: the Console records every command that writes, these two included; making the
  // fixture is not part of any journey, so the metarepo starts with nothing run, as a fresh one.
  await rm(join(root, ".atticus", "logs"), { recursive: true, force: true });
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

/**
 * ADR 0195 (CS5): the Forge estate as the slots make it. Every repo of fixtures/forge/repos is a
 * base clone under workspace/, and `atticus scan` has read them all, so each has its readers slot
 * (catalog/sources/readers/<repo>.json), and catalog/generated and catalog/sources/build.json are
 * the build's. The fixture is copied whole, because the Forge dialect's own tests read ../repos
 * beside the metarepo. The Console starts with nothing run, as on a fresh metarepo.
 */
export async function forgeSlotsMetarepo(): Promise<string> {
  const top = await mkdtemp(join(tmpdir(), "atticus-journey-"));
  await cp(join(FIXTURES, "forge"), top, { recursive: true });
  const root = join(top, "metarepo");
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
  for (const id of readdirSync(join(top, "repos"))) {
    const dir = join(root, "workspace", id);
    await cp(join(top, "repos", id), dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "Forge fixture");
  }
  const scan = atticus(root, "scan", "--no-drift");
  const repos = readdirSync(join(top, "repos"));
  if (!repos.every((r) => scan.includes(`catalog/sources/readers/${r}.json`)))
    throw new Error(`atticus scan didn't read every repo: ${scan}`);
  await rm(join(root, ".atticus", "logs"), { recursive: true, force: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Priya Nair");
  git(root, "config", "user.email", "priya@forge.example");
  await writeFile(join(root, ".gitignore"), "workspace/\n.index/\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "Forge metarepo, built from its slots");
  return root;
}

/** A commit in one of a slots metarepo's clones: a file written, or deleted with `null`. */
export function commitInClone(root: string, repo: string, path: string, text: string | null): void {
  const dir = join(root, "workspace", repo);
  const full = join(dir, ...path.split("/"));
  if (text === null) rmSync(full);
  else writeFileSync(full, text);
  const git = (...a: string[]) =>
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
      { cwd: dir, encoding: "utf8" },
    );
  git("add", "-A");
  git("commit", "-qm", `change ${path}`);
}

/** A slots metarepo and its own server for one journey (see forgeJourney). */
export function forgeSlotsJourney(): () => App {
  let app: App | undefined;
  test.describe.configure({ mode: "serial" });
  test.beforeAll(async () => {
    app = await startApp(await forgeSlotsMetarepo());
  });
  test.afterAll(async () => {
    if (!app) return;
    await stopApp(app);
    // The fixture was copied whole into the journey's own temporary folder.
    await rm(dirname(app.root), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return () => {
    if (!app) throw new Error("The journey's app hasn't started.");
    return app;
  };
}

/** The claim every fact of the Forge Studio fixture makes about its commit, until the clone's own. */
const STUDIO_COMMIT = '"commit":"0000000"';

/**
 * A metarepo made the Atticus 2 way (fixtures/forge-studio): `atticus init`, a manifest naming one
 * repo and its system, the repo cloned into the workspace, the assistant's facts and their
 * companions (questions, reviewed) verified with `atticus verify --write`, a probe that measured
 * Claude Code on this machine, and one change whose stages ran through stories and which waits on
 * its hand-off gate. Everything is invented (CLAUDE.md rule 3).
 */
export async function forgeStudioMetarepo(): Promise<string> {
  const STUDIO = join(FIXTURES, "forge-studio");
  const parent = await mkdtemp(join(tmpdir(), "atticus-journey-"));
  const run = (cwd: string, ...args: string[]) =>
    spawnSync(process.execPath, [BIN, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ATTICUS_RUNTIME: "hand-off" },
    });
  const init = run(parent, "init", "forge-studio", "--platform", "forge", "--owner", "priya");
  if (init.status !== 0) throw new Error(`atticus init failed: ${init.stdout}${init.stderr}`);
  const root = join(parent, "forge-studio");
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
  await writeFile(
    join(root, "org-pack/profiles/forge/repos.manifest.yaml"),
    [
      "schemaVersion: 1",
      "platform: forge",
      "repos:",
      "  - id: forge-studio",
      "    url: https://git.forge.example/forge/forge-studio.git",
      "    type: spring-boot",
      "    owner: team-studio",
      "    system: studio",
      "",
    ].join("\n"),
  );
  // The repo, cloned into the workspace at one commit.
  const clone = join(root, "workspace/forge-studio");
  await cp(join(STUDIO, "repo"), clone, { recursive: true });
  git(clone, "init", "-q", "-b", "main");
  git(clone, "add", "-A");
  git(clone, "commit", "-qm", "Forge Studio");
  const head = git(clone, "rev-parse", "HEAD").stdout.trim();
  // The facts the assistant wrote, with the clone's commit, beside their companions.
  await mkdir(join(root, "facts"), { recursive: true });
  await cp(join(STUDIO, "facts"), join(root, "facts"), { recursive: true });
  const facts = join(root, "facts/forge-studio.jsonl");
  await writeFile(
    facts,
    readFileSync(facts, "utf8").replaceAll(STUDIO_COMMIT, `"commit":"${head}"`),
  );
  const verify = atticus(root, "verify", "forge-studio", "--write");
  if (!/catalog/i.test(verify)) throw new Error(`atticus verify --write failed: ${verify}`);
  // Each flow's call-outs followed into the flows they reach (specs/estate.yaml).
  atticus(root, "join");
  // atticus probe measured Claude Code here: kept on this machine, never committed.
  await mkdir(join(root, ".atticus/probe"), { recursive: true });
  await writeFile(
    join(root, ".atticus/probe/claude-code.yaml"),
    [
      "schemaVersion: 1",
      "assistant: claude-code",
      `measured: "${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}"`,
      "tier: 1",
      "read: true",
      "write: true",
      "run: true",
      "answered: command",
      "",
    ].join("\n"),
  );
  // One change, its stages done through stories, waiting on its hand-off gate.
  atticus(root, "change", "new", "Add note tags", "--type", "feature", "--by", "priya");
  await cp(join(STUDIO, "change/add-note-tags"), join(root, "openspec/changes/add-note-tags"), {
    recursive: true,
  });
  git(root, "config", "user.name", "Priya Nair");
  git(root, "config", "user.email", "priya@forge.example");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "Forge Studio metarepo");
  return root;
}

/** A Forge Studio metarepo and its own server for one journey (see forgeJourney). */
export function forgeStudioJourney(): () => App {
  let app: App | undefined;
  test.describe.configure({ mode: "serial" });
  test.beforeAll(async () => {
    app = await startApp(await forgeStudioMetarepo());
  });
  test.afterAll(async () => {
    if (!app) return;
    await stopApp(app);
    // atticus init made the metarepo inside the journey's own temporary folder.
    await rm(dirname(app.root), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return () => {
    if (!app) throw new Error("The journey's app hasn't started.");
    return app;
  };
}

/** The commit each repo's facts of the reconnect fixture claim, until the clone's own. */
const RECONNECT_COMMITS: Record<string, string> = {
  "forge-orders": "a11ce01",
  "forge-billing": "b111ab1",
  "forge-ledger": "1ed9e42",
  "forge_billing_1-0": "9a7e0a1",
};

/**
 * Beta.30 ("it's connected to the wrong box", fixtures/reconnect): a metarepo whose repos are
 * read from facts, where forge-orders' calls are joined to forge-billing (by an address, by the
 * assistant's fact, through a gateway, and by a pairing sam made) and really go to forge-ledger.
 * `atticus init`, the fixture's profile and manifest, each repo cloned at one commit, its facts
 * with that commit, and `atticus verify <repo> --write` for each. Everything is invented
 * (CLAUDE.md rule 3).
 */
export async function reconnectMetarepo(): Promise<string> {
  const FIX = join(FIXTURES, "reconnect");
  const parent = await mkdtemp(join(tmpdir(), "atticus-journey-"));
  const init = spawnSync(
    process.execPath,
    [BIN, "init", "forge-estate", "--platform", "forge", "--owner", "priya"],
    { cwd: parent, encoding: "utf8", env: { ...process.env, ATTICUS_RUNTIME: "hand-off" } },
  );
  if (init.status !== 0) throw new Error(`atticus init failed: ${init.stdout}${init.stderr}`);
  const root = join(parent, "forge-estate");
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
  await cp(join(FIX, "org-pack/profiles/forge"), join(root, "org-pack/profiles/forge"), {
    recursive: true,
  });
  await mkdir(join(root, "facts"), { recursive: true });
  const text: Record<string, string> = {};
  for (const [repo, claimed] of Object.entries(RECONNECT_COMMITS)) {
    const clone = join(root, "workspace", repo);
    await cp(join(FIX, "repos", repo), clone, { recursive: true });
    git(clone, "init", "-q", "-b", "main");
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "Forge fixture");
    const head = git(clone, "rev-parse", "HEAD").stdout.trim();
    text[repo] = readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8").replaceAll(
      `"commit":"${claimed}"`,
      `"commit":"${head}"`,
    );
    await writeFile(join(root, "facts", `${repo}.jsonl`), text[repo]);
  }
  // A call sam paired with the wrong box, as Connect to… wrote it.
  const fact = (repo: string, id: string) =>
    text[repo]!.split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, any>) // eslint-disable-line @typescript-eslint/no-explicit-any -- a fact, read loosely
      .find((f) => f.id === id)!;
  const c = fact("forge-orders", "call.get.entries-id");
  const e = fact("forge-billing", "entry.get.entries-id");
  await writeFile(
    join(root, "facts/forge-orders.corrections.jsonl"),
    JSON.stringify({
      schemaVersion: 1,
      fact: c.id,
      target: { kind: "call", file: c.cite.file, line: c.cite.line, value: c.cite.value },
      action: "link",
      link: { repo: "forge-billing", entry: e.id, method: e.method, path: e.path },
      by: "sam",
      at: "2026-11-10T09:00:00.000Z",
    }) + "\n",
  );
  for (const repo of ["forge-billing", "forge-ledger", "forge_billing_1-0", "forge-orders"]) {
    const said = atticus(root, "verify", repo, "--write");
    if (!/Wrote the catalog/.test(said))
      throw new Error(`atticus verify ${repo} --write failed: ${said}`);
  }
  await rm(join(root, ".atticus", "logs"), { recursive: true, force: true });
  await writeFile(join(root, ".gitignore"), "workspace/\n.index/\n");
  git(root, "config", "user.name", "Priya Nair");
  git(root, "config", "user.email", "priya@forge.example");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "Forge estate, read from facts");
  return root;
}

/** A reconnect metarepo and its own server for one journey (see forgeJourney). */
export function reconnectJourney(): () => App {
  let app: App | undefined;
  test.describe.configure({ mode: "serial" });
  test.beforeAll(async () => {
    app = await startApp(await reconnectMetarepo());
  });
  test.afterAll(async () => {
    if (!app) return;
    await stopApp(app);
    await rm(dirname(app.root), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return () => {
    if (!app) throw new Error("The journey's app hasn't started.");
    return app;
  };
}

export interface App {
  url: string;
  root: string;
  server: ChildProcess;
}

/** Servers stopApp is stopping: their exit was asked for. */
const stopping = new WeakSet<ChildProcess>();

/** Start `atticus ui` on a free port and wait for its address. */
export async function startApp(root: string): Promise<App> {
  // The person's own app: started from their terminal, never a coding assistant's, whatever runs
  // the journeys (an assistant's marks make the app record the assistant, which accepts nothing).
  const env = { ...process.env };
  for (const k of ["ATTICUS_ASSISTANT", "CLAUDECODE", "GEMINI_CLI", "CURSOR_AGENT"]) delete env[k];
  const server = spawn(process.execPath, [BIN, "ui", "--port", "0", "--root", root], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
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
    server.on("exit", (c, sig) => {
      reject(new Error(`atticus ui exited ${c}: ${out}`));
      // After it started, an exit nobody asked for is said with what the server printed last, so
      // a journey that then can't connect names why (the CI of beta.28.2: ERR_CONNECTION_FAILED).
      if (!stopping.has(server))
        process.stderr.write(
          `\natticus ui exited unasked (code ${c}, signal ${sig}):\n${out.slice(-8000)}\n`,
        );
    });
  });
  return { url, root, server };
}

export async function stopApp(a: App): Promise<void> {
  // Wait for the server to exit: until then it may still be writing its log.
  if (a.server.exitCode === null && a.server.signalCode === null) {
    const exited = new Promise((resolve) => a.server.once("exit", resolve));
    stopping.add(a.server);
    a.server.kill();
    await exited;
  }
  await rm(a.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// ------------------------------------------------------------------ page helpers

/** Go to a screen by its route and wait for its first panel. */
export async function open(page: Page, app: App, route: string): Promise<void> {
  // The tour opens once /api/health names the metarepo: on a slow machine (CI) that can be after
  // the page looks settled, and the tour then covered the next click. Wait for it first.
  const health = page
    .waitForResponse((r) => new URL(r.url()).pathname === "/api/health", { timeout: 15_000 })
    .catch(() => undefined);
  await page.goto(`${app.url}/#/${route}`);
  await expect(page.locator(".panel").first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  await health;
  // Two frames: the answer is rendered (the tour, if it is to open, is open).
  await page.evaluate(
    "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))",
  );
  await skipTour(page);
}

/** Each test is a fresh browser, so the first-run tour opens again: skip it. */
async function skipTour(page: Page): Promise<void> {
  const skip = page.getByRole("button", { name: "Skip the tour" });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

/**
 * ADR 0194: open the app in the classic layout (the menu on the left, one page at a time) for
 * this page, as Settings › Layout keeps it; the IDE layout is the default.
 */
export async function classicLayout(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("atticus.layout", "classic");
    } catch {
      // No storage: the default layout.
    }
  });
}

/**
 * Ask Atticus a question in plain words: the classic layout's Ask box, or in the IDE layout the
 * title bar's box, which opens Ctrl+K, and its Ask line.
 */
export async function ask(page: Page, question: string): Promise<void> {
  const box = page.locator("#ask");
  if (await box.count()) {
    await box.fill(question);
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    return;
  }
  await page.getByRole("button", { name: /^Search the estate, ask, or run a command/ }).click();
  const dialog = page.getByRole("dialog", { name: "Go to anything" });
  await dialog.getByRole("combobox").fill(question);
  await dialog.getByRole("option", { name: `Ask: ${question}` }).click();
}

/** WCAG 2.1 AA: no moderate, serious or critical axe violation on the page as it is now (WP5.6). */
export async function accessible(page: Page, where: string): Promise<void> {
  const r = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const bad = r.violations
    .filter((v) => v.impact === "moderate" || v.impact === "serious" || v.impact === "critical")
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help} — ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(" "))
          .join(" | ")}`,
    );
  expect(bad, `accessibility on ${where}`).toEqual([]);
}

// ------------------------------------------------------------------ the field-shaped estate

/**
 * Beta.30 (slice 9): the estates a journey runs on. `tidy` is the Forge fixture of seven tidy
 * repos (fixtures/forge/metarepo); `field` is the field-shaped estate (fixtures/forge-field, made
 * from packages/cli/test/field-estate.ts by scripts/write-field-fixture.mjs), which holds every
 * shape a field report has named: gateway proxies whose targets are deploy tokens (`@name@`,
 * `${NAME}`), a repo with no System, ids with dots, nested payload fields, ssh and https origins,
 * a non-gateway callee, an empty repo and a repo nobody read, a topic with consumers in two repos,
 * hand pairings, a legacy slot from before the upgrade and a call joined to the wrong box.
 */
export type Estate = "tidy" | "field";
export const ESTATES: readonly Estate[] = ["tidy", "field"];

const FIELD = join(FIXTURES, "forge-field");

/** What fixtures/forge-field/estate.json says of the field estate (packages/cli/test/forge-field.ts). */
export interface FieldInfo {
  /** The repos read from facts. */
  repos: string[];
  /** The services whose records are kept from before the upgrade. */
  legacy: string[];
  links: number;
  suppressed: string[];
  emptyRepo?: string;
  unreadRepo?: string;
  topic?: { name: string; publisher: string; listener: string; listeners: string[] };
  wrongBox?: {
    from: string;
    call: string;
    method: string;
    path: string;
    joins: string;
    goes: string;
  };
  /** The change the metarepo holds: on the quick path, its four files written. */
  change: string;
  /** The commit of each clone, which its facts cite. */
  commits: Record<string, string>;
  /** The repos whose clones are under repos/. */
  clones: string[];
  /** Every repo the manifest lists. */
  manifest: string[];
}

export function fieldInfo(): FieldInfo {
  return JSON.parse(readFileSync(join(FIELD, "estate.json"), "utf8")) as FieldInfo;
}

/** The change each estate's metarepo holds, for the routes that name one. */
export function changeOf(estate: Estate): string {
  return estate === "tidy" ? "add-transfer-limit" : fieldInfo().change;
}

/**
 * The field-shaped estate as a team has it after the upgrade: the fixture's metarepo, its clones
 * in the workspace (and the empty repo's clone with nothing in it), the catalog built with
 * `atticus catalog build`, and the metarepo committed. The Console starts with nothing run.
 */
export async function forgeFieldMetarepo(): Promise<string> {
  const info = fieldInfo();
  const root = await mkdtemp(join(tmpdir(), "atticus-journey-field-"));
  await cp(join(FIELD, "metarepo"), root, { recursive: true });
  // The stamp names the Atticus that wrote the fixture: the one under test upgraded it, so a
  // release since doesn't make every page say to upgrade.
  const version = /\d+\.\d+\.\d+\S*/.exec(
    spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).stdout,
  )?.[0];
  if (!version) throw new Error("atticus --version named no version.");
  const stamp = join(root, ".atticus", "metarepo.yaml");
  writeFileSync(
    stamp,
    readFileSync(stamp, "utf8").replace(/^atticus: .*$/m, `atticus: ${version}`),
  );
  // Each clone at its one commit, made the same on every machine (packages/cli/test/forge-field.ts
  // `commitClone`): its facts cite that commit. Hermetic: no user or system git config is read.
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Forge",
    GIT_AUTHOR_EMAIL: "forge@example.com",
    GIT_COMMITTER_NAME: "Forge",
    GIT_COMMITTER_EMAIL: "forge@example.com",
    GIT_AUTHOR_DATE: "2026-11-01T09:00:00Z",
    GIT_COMMITTER_DATE: "2026-11-01T09:00:00Z",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  for (const id of info.clones) {
    const clone = join(root, "workspace", id);
    await cp(join(FIELD, "repos", id), clone, { recursive: true });
    const g = (...a: string[]) => {
      const r = spawnSync(
        "git",
        [
          "-c",
          "core.autocrlf=false",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.filemode=false",
          ...a,
        ],
        { cwd: clone, env, encoding: "utf8" },
      );
      if (r.status !== 0)
        throw new Error(`git ${a.join(" ")} failed in ${id}'s clone: ${r.stderr || r.error}`);
      return r.stdout.trim();
    };
    g("init", "-q", "-b", "main", "--object-format=sha1");
    g("add", "-A");
    g("commit", "-q", "--no-verify", "-m", "Forge fixture");
    const head = g("rev-parse", "HEAD");
    if (head !== info.commits[id])
      throw new Error(
        `${id}'s clone is at ${head}, not ${info.commits[id]} as its facts say: run node scripts/write-field-fixture.mjs.`,
      );
  }
  if (info.emptyRepo)
    await mkdir(join(root, "workspace", info.emptyRepo, ".git"), { recursive: true });
  const built = atticus(root, "catalog", "build");
  if (!existsSync(join(root, "catalog/sources/build.json")))
    throw new Error(`atticus catalog build didn't build the field estate: ${built}`);
  await rm(join(root, ".atticus", "logs"), { recursive: true, force: true });
  // The metarepo's own .gitignore (atticus init's) keeps the workspace and local state out.
  const git = (...a: string[]) =>
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
      { cwd: root, encoding: "utf8" },
    );
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Priya Nair");
  git("config", "user.email", "priya@forge.example");
  git("add", "-A");
  git("commit", "-qm", "Forge estate, field-shaped");
  return root;
}

/**
 * A route of the tidy estate as the estate given has it: its change, and the component an impact
 * walk starts from (on the field estate, the topic's publisher, whose walk reaches both of the
 * topic's consumers). The tidy estate's routes are as they are.
 */
export function routeOf(estate: Estate, route: string): string {
  if (estate === "tidy") return route;
  return route
    .replaceAll("add-transfer-limit", fieldInfo().change)
    .replace(/([?&]q=)ledger-api\b/, `$1${fieldInfo().topic!.publisher}`);
}

/** A metarepo of the estate given: the tidy Forge fixture, or the field-shaped one. */
export function metarepoOf(estate: Estate): Promise<string> {
  return estate === "tidy" ? forgeMetarepo() : forgeFieldMetarepo();
}

/**
 * A fresh Forge metarepo and its own server for one journey (one test file, or one describe of
 * it per estate): its steps run in order and share the state they build, and no journey sees
 * another's. `estate: "field"` seeds the field-shaped estate instead of the tidy one.
 */
export function forgeJourney(o: { estate?: Estate } = {}): () => App {
  let app: App | undefined;
  test.describe.configure({ mode: "serial" });
  test.beforeAll(async () => {
    app = await startApp(await metarepoOf(o.estate ?? "tidy"));
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
