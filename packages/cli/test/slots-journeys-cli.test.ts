import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { listQuestions, writeQuestion } from "@maycombhq/core";

/**
 * ADR 0195, ticket CS5: the source slots end to end through the command line, as a person types
 * the commands. Each test is one of the stories the ADR promises: a scan that couldn't read a repo
 * keeps that repo's last good read and says why; a dirty clone is no observation; verify --write
 * and a scan can't undo each other; a large removal waits for its count; an unexplained one
 * refuses; an answer's removal is listed; a hand edit is kept until it is made curated or its
 * discard is confirmed; undo takes back the last five builds; prune asks first; the upgrade of a
 * beta.26 metarepo is shown first and lossless; a rename keeps the curated decisions. Invented
 * Forge estate only (CLAUDE.md rule 3), no network (rule 5).
 */

const { main } = await import("../src/main.js");
const { verifyCommand } = await import("../src/verify-commands.js");
const { questionsFiles } = await import("../src/question-commands.js");
const { buildAndWrite, parseBuildManifest, parseReadersSlot, serializeBuildManifest, undoDirOf } =
  await import("@maycombhq/scanner");

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../../fixtures");
const FORGE = join(FIXTURES, "forge");
const BETA26 = join(FIXTURES, "forge-beta26");
const VERIFY = join(HERE, "../../verify/test/fixtures");
const GATEWAY = join(FIXTURES, "link-estate", "gateway-questions");
const T = 300_000;
const update = process.env.UPDATE_GOLDEN === "1";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
    out,
    err,
    all: () => [...out, ...err].join("\n"),
  };
}

/** Run one atticus command against a metarepo, as a person would type it. */
async function atticus(root: string, ...args: string[]) {
  const c = capture();
  const code = await main([...args, "--root", root], c.io);
  return { code, ...c };
}

/** The same command with --json, its report parsed. */
async function atticusJson<T = Record<string, unknown>>(root: string, ...args: string[]) {
  const r = await atticus(root, ...args, "--json");
  return { ...r, json: JSON.parse(r.out.join("\n")) as T };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "init.defaultBranch=main",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, stdio: "pipe" },
  )
    .toString()
    .trim();
}

const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

async function temp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

/** Every file under a folder, by its path, with its bytes. */
function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).split("\\").join("/")] = readFileSync(p, "utf8");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

const generated = (root: string) => join(root, "catalog", "generated");
const sources = (root: string) => join(root, "catalog", "sources");
const readers = (root: string, repo: string) => join(sources(root), "readers", `${repo}.json`);
/** Everything a build may write: catalog/generated, the slots and build.json. */
const catalogBytes = (root: string) => ({
  generated: files(generated(root)),
  sources: files(sources(root)),
});

/** A file committed to a clone. */
async function commitFile(root: string, repo: string, path: string, text: string | null) {
  const dir = join(root, "workspace", repo);
  const full = join(dir, ...path.split("/"));
  if (text === null) await rm(full);
  else {
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `change ${path}`);
  return git(dir, "rev-parse", "HEAD");
}

let forgeTemplate: string | undefined;
/**
 * The Forge fixture with every repo a base clone and scanned once, so every repo has a readers
 * slot, catalog/generated and build.json; a fresh copy each time.
 */
async function scannedForge(): Promise<string> {
  if (!forgeTemplate) {
    const top = await temp("atticus-cs5-forge-");
    await cp(FORGE, top, { recursive: true });
    const root = join(top, "metarepo");
    for (const id of await readdir(join(top, "repos"))) {
      const dir = join(root, "workspace", id);
      await cp(join(top, "repos", id), dir, { recursive: true });
      git(dir, "init", "-q");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "fixture");
    }
    const r = await atticus(root, "scan", "--no-drift");
    expect(r.code, r.all()).toBe(0);
    forgeTemplate = top;
  }
  // The whole fixture: the Forge dialect's own tests read ../repos/ beside the metarepo.
  const copy = await temp("atticus-cs5-copy-");
  await cp(forgeTemplate, copy, { recursive: true });
  return join(copy, "metarepo");
}

interface Source {
  repo: string;
  source: string;
  slot: string;
  commit?: string;
  reason?: string;
}
interface Refused {
  reasons: string[];
  message: string;
  removals?: { kind: string; id: string; repos: string[]; explainedBy: string[] }[];
  unexplained?: { kind: string; id: string }[];
  allowRemovals?: number;
  edits?: { path: string; how: string }[];
  discardEdits?: number;
}
interface ScanReport {
  written: boolean;
  sources: Source[];
  refused?: Refused;
}

describe("a scan writes only what it read in full, and keeps every other repo's last good read (ADR 0195 points 1 and 5)", () => {
  it(
    "a repo not cloned keeps its slot and its records, and the scan says why, while the others are written",
    async () => {
      const root = await scannedForge();
      const ledger = readFileSync(readers(root, "forge-ledger"), "utf8");
      const before = files(generated(root));
      expect(Object.keys(before)).toContain("table/ledger-db.entry.yaml");
      await rm(join(root, "workspace", "forge-ledger"), { recursive: true });
      // forge-events moved on: its new read is written.
      const head = await commitFile(root, "forge-events", "NOTES.md", "moved on\n");
      const r = await atticus(root, "scan", "--no-drift");
      // The ledger's slot is byte for byte its last good read, and its records are all there.
      expect(readFileSync(readers(root, "forge-ledger"), "utf8")).toBe(ledger);
      const after = files(generated(root));
      for (const [p, text] of Object.entries(before))
        if (p.startsWith("table/") || p.startsWith("column/")) expect(after[p], p).toBe(text);
      const events = parseReadersSlot(readFileSync(readers(root, "forge-events"), "utf8"));
      expect(events.ok && events.slot.commit).toBe(head);
      expect(r.out.join("\n")).toMatch(
        /forge-ledger: its readers slot keeps its last good read \(commit [0-9a-f]{7}\): it isn't cloned here\./,
      );
      expect(r.out.join("\n")).toContain("slots: catalog/sources/readers/forge-events.json");
      expect(r.out.join("\n")).toMatch(/catalog\/sources\/readers: 1 written, 5 unchanged/);
      const j = await atticusJson<ScanReport>(root, "scan", "--no-drift");
      expect(j.json.written).toBe(true);
      expect(j.json.sources.find((s) => s.repo === "forge-ledger")).toMatchObject({
        source: "readers",
        slot: "kept-last-good",
        reason: "not-cloned",
      });
      // ADR 0195 consequences: `kept` (beta.26's carry summary) is gone from --json.
      expect(j.json).not.toHaveProperty("kept");
    },
    T,
  );

  it(
    "a clone with changes not committed is no observation: its slot keeps the commit it was read at",
    async () => {
      const root = await scannedForge();
      const bff = readFileSync(readers(root, "forge-portal-bff"), "utf8");
      const before = catalogBytes(root);
      const yml = join(root, "workspace/forge-portal-bff/src/main/resources/application.yml");
      if (existsSync(yml)) await writeFile(yml, `${readFileSync(yml, "utf8")}\n# edited\n`);
      else await writeFile(join(root, "workspace/forge-portal-bff/NOTES.md"), "not committed\n");
      const r = await atticus(root, "scan", "--no-drift");
      expect(readFileSync(readers(root, "forge-portal-bff"), "utf8")).toBe(bff);
      expect(r.out.join("\n")).toMatch(
        /forge-portal-bff: its readers slot keeps its last good read \(commit [0-9a-f]{7}\): its clone has changes not committed/,
      );
      // Nothing else moved, so nothing else was written.
      expect(catalogBytes(root)).toEqual(before);
      const j = await atticusJson<ScanReport>(root, "scan", "--no-drift");
      expect(j.json.sources.find((s) => s.repo === "forge-portal-bff")).toMatchObject({
        slot: "kept-last-good",
        reason: "dirty",
      });
    },
    T,
  );
});

/** The two-repo verify metarepo (packages/verify/test/fixtures), the ledger cloned, its facts in place. */
async function verifyMetarepo(): Promise<{ root: string; dir: string; commit: string }> {
  const root = await temp("atticus-cs5-verify-");
  await cp(join(VERIFY, "metarepo", "org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(VERIFY, "metarepo", "catalog"), join(root, "catalog"), { recursive: true });
  const dir = join(root, "workspace", "forge-ledger");
  await cp(join(VERIFY, "repo"), dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
  const commit = git(dir, "rev-parse", "HEAD");
  await mkdir(join(root, "facts"), { recursive: true });
  const facts = readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8");
  await writeFile(join(root, "facts", "forge-ledger.jsonl"), facts.replaceAll("0123abc", commit));
  return { root, dir, commit };
}

describe("verify --write, then a scan, keeps the facts' records (ADR 0195 points 1 to 3)", () => {
  it(
    "the scan writes the readers slot and leaves the facts snapshot and every record projected from the facts",
    async () => {
      const { root, dir } = await verifyMetarepo();
      const v = capture();
      expect(
        await verifyCommand(root, "forge-ledger", { dir, write: true }, v.io),
        v.err.join("\n"),
      ).toBe(0);
      const facts = files(join(sources(root), "facts"));
      expect(Object.keys(facts).sort()).toEqual(["forge-ledger.jsonl", "forge-ledger.meta.json"]);
      const catalog = files(generated(root));
      expect(Object.keys(catalog).length).toBeGreaterThan(0);
      // The curated decisions of the fixture are in the catalog after the write ...
      expect(JSON.stringify(catalog)).toMatch(/oauth2/);
      const r = await atticusJson<ScanReport>(root, "scan", "--no-drift");
      // ... and the scan, which never writes a facts slot, changes no byte of it, nor of a
      // record the facts project (readers never destroy facts).
      expect(files(join(sources(root), "facts"))).toEqual(facts);
      expect(r.json.sources.find((s) => s.repo === "forge-ledger")).toMatchObject({
        source: "facts",
      });
      expect(existsSync(readers(root, "forge-ledger"))).toBe(true);
      expect(files(generated(root))).toEqual(catalog);
      // A second verify --write of the same facts changes nothing either.
      expect(await verifyCommand(root, "forge-ledger", { dir, write: true }, capture().io)).toBe(0);
      expect(files(generated(root))).toEqual(catalog);
    },
    T,
  );
});

describe("the removal guards (ADR 0195 point 4)", () => {
  it(
    "a large removal refuses and lists its count; a wrong count refuses again; the right count writes",
    async () => {
      const root = await scannedForge();
      await commitFile(
        root,
        "forge-ledger",
        "src/main/resources/db/migration/V2__create_entry.sql",
        null,
      );
      const before = catalogBytes(root);
      const first = await atticusJson<ScanReport>(root, "scan", "--no-drift");
      expect(first.code).toBe(1);
      expect(first.json.written).toBe(false);
      const refused = first.json.refused!;
      expect(refused.reasons).toContain("large-removals");
      const n = refused.allowRemovals!;
      expect(n).toBeGreaterThan(2);
      expect(refused.removals!.map((x) => `${x.kind}/${x.id}`)).toContain("Table/ledger-db.entry");
      expect(catalogBytes(root)).toEqual(before);
      // The same in words, with the command that confirms exactly these.
      const said = await atticus(root, "scan", "--no-drift");
      expect(said.err.join("\n")).toMatch(new RegExp(`This would remove ${n} records`));
      expect(said.err.join("\n")).toContain(`atticus scan --allow-removals ${n}`);
      // A count other than the one listed confirms nothing.
      const wrong = await atticus(root, "scan", "--no-drift", "--allow-removals", String(n + 1));
      expect(wrong.code).toBe(1);
      expect(wrong.err.join("\n")).toContain(
        `--allow-removals ${n + 1} doesn't name the ${n} listed`,
      );
      expect(catalogBytes(root)).toEqual(before);
      const right = await atticus(root, "scan", "--no-drift", "--allow-removals", String(n));
      expect(right.code, right.all()).toBe(0);
      expect(right.out.join("\n")).toMatch(new RegExp(`Removed ${n} records`));
      expect(existsSync(join(generated(root), "table", "ledger-db.entry.yaml"))).toBe(false);
      expect(existsSync(join(generated(root), "table", "ledger-db.account.yaml"))).toBe(true);
    },
    T,
  );

  it(
    "a removal nothing explains refuses with its list, and no flag forces it",
    async () => {
      const root = await scannedForge();
      // A record the last build wrote whose every source is unchanged: no build makes it now,
      // and nothing explains its going (the shape of a bug in a pass).
      const mPath = join(sources(root), "build.json");
      const m = parseBuildManifest(readFileSync(mPath, "utf8"));
      if (!m.ok) throw new Error("build.json doesn't read");
      const like = m.slot.files.find((f) => f.path.endsWith("component/ledger-api.yaml"))!;
      const text = readFileSync(
        join(generated(root), "component", "ledger-api.yaml"),
        "utf8",
      ).replaceAll("ledger-api", "ledger-ghost");
      await writeFile(join(generated(root), "component", "ledger-ghost.yaml"), text);
      const { createHash } = await import("node:crypto");
      const ghost = {
        ...like,
        path: like.path.replace("ledger-api.yaml", "ledger-ghost.yaml"),
        sha256: createHash("sha256").update(text).digest("hex"),
      };
      await writeFile(
        mPath,
        serializeBuildManifest({
          ...m.slot,
          files: [...m.slot.files, ghost].sort((a, b) => (a.path < b.path ? -1 : 1)),
        }),
      );
      const before = catalogBytes(root);
      const r = await atticusJson<{ refused?: Refused }>(root, "catalog", "build");
      expect(r.code).toBe(1);
      expect(r.json.refused?.reasons).toContain("unexplained-removals");
      expect(r.json.refused?.unexplained?.map((x) => x.id)).toEqual(["ledger-ghost"]);
      const said = await atticus(root, "catalog", "build", "--allow-removals", "1");
      expect(said.code).toBe(1);
      expect(said.err.join("\n")).toMatch(/That is a bug: nothing is written/);
      expect(said.err.join("\n")).toContain("Component/ledger-ghost");
      expect(catalogBytes(root)).toEqual(before);
    },
    T,
  );
});

describe("a removal an answer causes is the person's own action, written and listed (ADR 0195, owner's answer 3)", () => {
  const COMMIT: Record<string, string> = {
    "forge-ledger-core": "e5e0001",
    "forge-card-vault": "f6f0001",
    "forge-proxy-core-v1": "d4d0001",
    "forge-teller-app": "a7a0001",
  };
  const TELLER = "forge-teller-app";
  const AT = new Date("2026-11-10T10:00:00.000Z");
  const GROUP =
    "Which repo or system answers the calls forge-teller-app makes under /forge through core-gateway?";

  async function estate(): Promise<string> {
    const root = await temp("atticus-cs5-answer-");
    await cp(join(GATEWAY, "org-pack"), join(root, "org-pack"), { recursive: true });
    await cp(join(GATEWAY, "questions"), join(root, "questions"), { recursive: true });
    await mkdir(join(root, "facts"), { recursive: true });
    for (const r of Object.keys(COMMIT)) {
      await cp(join(GATEWAY, "repos", r), join(root, "workspace", r), { recursive: true });
      await writeFile(
        join(root, "facts", `${r}.jsonl`),
        readFileSync(join(GATEWAY, "facts", `${r}.jsonl`), "utf8"),
      );
    }
    return root;
  }
  async function verify(root: string, repo: string) {
    const c = capture();
    const code = await verifyCommand(
      root,
      repo,
      { commit: COMMIT[repo]!, dir: join(root, "workspace", repo), write: true, now: () => AT },
      c.io,
    );
    expect(code, c.all()).toBe(0);
  }

  interface Built {
    removed: { kind: string; id: string; explainedBy: string[] }[];
    refused?: Refused;
  }
  /** `atticus catalog build`, and when it waits on a large removal, the result of confirming it. */
  async function build(root: string): Promise<Built> {
    const first = (await atticusJson<Built>(root, "catalog", "build")).json;
    if (!first.refused?.reasons.includes("large-removals")) return first;
    const n = String(first.refused.allowRemovals);
    const again = await atticusJson<Built>(root, "catalog", "build", "--allow-removals", n);
    expect(again.code, again.all()).toBe(0);
    return { ...again.json, refused: first.refused };
  }

  it(
    "an answer that takes a call's box off the map: the build lists what it removed and why",
    async () => {
      const root = await estate();
      for (const r of Object.keys(COMMIT)) await verify(root, r);
      const q = (await listQuestions(root)).questions.find((x) => x.question === GROUP)!;
      // As a person answered before beta.24: words that became a box on the map.
      await writeQuestion(root, {
        ...q,
        state: "answered",
        answer: {
          text: "ignore this, its cicd related",
          by: "pat",
          at: AT.toISOString(),
          scope: { level: "repo", id: TELLER },
        },
      });
      // The build after the answer: the calls the answer placed leave the Unresolved list. They
      // are more than 10% of forge-teller-app's records, so they wait for their count, each listed
      // with the answered question as what explains it; confirmed, they are written and listed.
      const words = await build(root);
      expect(words.refused?.reasons).toEqual(["large-removals"]);
      expect(words.refused!.removals!.length).toBeGreaterThan(0);
      for (const x of words.refused!.removals!)
        expect(x.explainedBy).toEqual(["an input changed (questions)"]);
      const boxed = Object.entries(files(generated(root))).filter(([, t]) => /ignore-this/.test(t));
      expect(boxed.length).toBeGreaterThan(0);
      // The person answers Ignore instead, and builds.
      const c = capture();
      expect(
        await questionsFiles(
          root,
          ["questions", "answer", q.id, "--ignore", "--reason", "cicd", "--by", "pat"],
          c.io,
          { now: AT },
        ),
        c.all(),
      ).toBe(0);
      const b = await build(root);
      const gone = Object.entries(files(generated(root))).filter(([, t]) => /ignore-this/.test(t));
      expect(gone).toEqual([]);
      // Each removal is listed with the input that explains it: the answered question.
      expect(b.removed.length).toBeGreaterThanOrEqual(boxed.length);
      for (const x of b.removed) expect(x.explainedBy).toEqual(["an input changed (questions)"]);
    },
    T,
  );
});

describe("hand edits to catalog/generated are never overwritten (ADR 0195 point 4)", () => {
  const edited = (root: string) => join(generated(root), "component", "ledger-api.yaml");
  async function handEdit(root: string): Promise<string> {
    const text = readFileSync(edited(root), "utf8");
    const now = /^runtime: .*$/m.test(text)
      ? text.replace(/^runtime: .*$/m, "runtime: openshift")
      : `${text.trimEnd()}\nruntime: openshift\n`;
    await writeFile(edited(root), now);
    return now;
  }

  it(
    "a build and a scan refuse and list the edit; made curated, every later build and scan keeps it",
    async () => {
      const root = await scannedForge();
      await handEdit(root);
      const before = catalogBytes(root);
      for (const args of [
        ["catalog", "build"],
        ["scan", "--no-drift"],
      ]) {
        const r = await atticusJson<{ refused?: Refused }>(root, ...args);
        expect(r.code, args.join(" ")).toBe(1);
        expect(r.json.refused?.reasons).toContain("hand-edits");
        expect(r.json.refused?.edits).toEqual([
          { path: "catalog/generated/component/ledger-api.yaml", how: "changed" },
        ]);
        expect(catalogBytes(root)).toEqual(before);
      }
      const listed = await atticus(root, "catalog", "edits");
      expect(listed.code).toBe(1);
      expect(listed.out.join("\n")).toContain(
        "changed: catalog/generated/component/ledger-api.yaml",
      );
      const curate = await atticus(root, "catalog", "edits", "--curate", "--by", "priya");
      expect(curate.code, curate.all()).toBe(0);
      const decisions = files(join(root, "catalog", "curated"));
      expect(Object.keys(decisions).length).toBe(1);
      expect(Object.values(decisions)[0]).toMatch(/action: assert/);
      expect(Object.values(decisions)[0]).toMatch(/runtime: openshift/);
      expect(readFileSync(edited(root), "utf8")).toMatch(/runtime: openshift/);
      // A scan after it, of a repo that moved on, keeps the edit's effect.
      await commitFile(root, "forge-ledger", "NOTES.md", "moved on\n");
      const scan = await atticus(root, "scan", "--no-drift");
      expect(scan.code, scan.all()).toBe(0);
      expect(readFileSync(edited(root), "utf8")).toMatch(/runtime: openshift/);
      expect((await atticus(root, "catalog", "build", "--check")).code).toBe(0);
    },
    T,
  );

  it(
    "a discard is confirmed with the count listed, and the edited bytes go into the undo copy first",
    async () => {
      const root = await scannedForge();
      const built = readFileSync(edited(root), "utf8");
      const mine = await handEdit(root);
      const wrong = await atticus(root, "catalog", "build", "--discard-edits", "2");
      expect(wrong.code).toBe(1);
      expect(wrong.err.join("\n")).toContain("--discard-edits 2 doesn't name the 1 listed");
      expect(readFileSync(edited(root), "utf8")).toBe(mine);
      const right = await atticus(root, "catalog", "build", "--discard-edits", "1");
      expect(right.code, right.all()).toBe(0);
      expect(right.out.join("\n")).toMatch(/Discarded 1 hand edit/);
      expect(readFileSync(edited(root), "utf8")).toBe(built);
      const undo = files(await undoDirOf(root));
      expect(Object.values(undo)).toContain(mine);
      // And undo puts the edit back.
      await atticus(root, "catalog", "undo", "--yes");
      expect(readFileSync(edited(root), "utf8")).toBe(mine);
    },
    T,
  );

  // ADR 0195 point 7: an undo of a discard restores the edit, and its check against the
  // restored build.json accepts the edits the copy holds as discarded.
  it(
    "undo of a confirmed discard puts the hand edit back and succeeds",
    async () => {
      const root = await scannedForge();
      const mine = await handEdit(root);
      expect((await atticus(root, "catalog", "build", "--discard-edits", "1")).code).toBe(0);
      const back = await atticus(root, "catalog", "undo", "--yes");
      expect(back.code, back.all()).toBe(0);
      expect(readFileSync(edited(root), "utf8")).toBe(mine);
    },
    T,
  );
});

describe("atticus catalog undo takes back the last five builds (ADR 0195 point 7)", () => {
  it(
    "six builds keep five copies; undo restores the latest byte for byte, can itself be undone, and undo <n> goes back further",
    async () => {
      const root = await scannedForge();
      const states: ReturnType<typeof catalogBytes>[] = [catalogBytes(root)];
      // Six scans, each of a read that adds an endpoint to forge-ledger.
      const ctl = "src/main/java/forge/ledger/LedgerEndpoints.java";
      const base = readFileSync(join(root, "workspace", "forge-ledger", ctl), "utf8");
      for (let i = 1; i <= 6; i++) {
        await commitFile(root, "forge-ledger", "NOTES.md", `build ${i}\n`);
        await commitFile(
          root,
          "forge-ledger",
          ctl,
          base.replace(/\n\}\s*$/, `\n  // build ${i}\n}\n`),
        );
        const r = await atticus(root, "scan", "--no-drift");
        expect(r.code, r.all()).toBe(0);
        states.push(catalogBytes(root));
      }
      // Each scan wrote at least its slot: six states, each different from the one before.
      for (let i = 1; i < states.length; i++) expect(states[i]).not.toEqual(states[i - 1]);
      const listed = await atticusJson<{ copies: { n: number; command: string }[] }>(
        root,
        "catalog",
        "undo",
      );
      expect(listed.code).toBe(0);
      expect(listed.json.copies.length).toBe(5);
      // Nothing is put back without --yes.
      expect(catalogBytes(root)).toEqual(states[6]);
      const undo = await atticus(root, "catalog", "undo", "--yes");
      expect(undo.code, undo.all()).toBe(0);
      expect(catalogBytes(root)).toEqual(states[5]);
      // The undo can be undone.
      const redo = await atticus(root, "catalog", "undo", "--yes");
      expect(redo.code, redo.all()).toBe(0);
      expect(catalogBytes(root)).toEqual(states[6]);
      // undo <n>: back to before an older build, taking the later ones back in order.
      const now = await atticusJson<{ copies: { n: number; command: string }[] }>(
        root,
        "catalog",
        "undo",
      );
      // Newest first: the redo, the undo, then the scans' copies; the undo and the redo cancel.
      const scans = now.json.copies.filter((c) => c.command.startsWith("atticus scan"));
      const oldest = scans.at(-1)!;
      const back = await atticus(root, "catalog", "undo", String(oldest.n), "--yes");
      expect(back.code, back.all()).toBe(0);
      expect(catalogBytes(root)).toEqual(states[6 - scans.length]);
    },
    T,
  );
});

describe("slot files are never deleted without asking (ADR 0195 point 4)", () => {
  it(
    "a repo taken out of the manifests leaves through the confirmed guard, keeps its slot, and prune asks first",
    async () => {
      const root = await scannedForge();
      const manifest = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
      const text = readFileSync(manifest, "utf8");
      await writeFile(manifest, text.replace(/ {2}- id: forge-reports-job\n(?: {4}.*\n)+/, ""));
      const refused = await atticusJson<{ refused?: Refused }>(root, "catalog", "build");
      expect(refused.code).toBe(1);
      expect(refused.json.refused?.reasons).toContain("large-removals");
      const n = refused.json.refused!.allowRemovals!;
      const ok = await atticus(root, "catalog", "build", "--allow-removals", String(n));
      expect(ok.code, ok.all()).toBe(0);
      expect(existsSync(readers(root, "forge-reports-job"))).toBe(true);
      expect(ok.out.join("\n")).toMatch(
        /forge-reports-job: no longer in the manifests, so its slots aren't built from; they are kept/,
      );
      const asked = await atticus(root, "catalog", "prune");
      expect(asked.code).toBe(0);
      expect(asked.out.join("\n")).toContain("catalog/sources/readers/forge-reports-job.json");
      expect(asked.out.join("\n")).toMatch(/Nothing removed/);
      expect(existsSync(readers(root, "forge-reports-job"))).toBe(true);
      const slot = readFileSync(readers(root, "forge-reports-job"), "utf8");
      const pruned = await atticus(root, "catalog", "prune", "--yes");
      expect(pruned.code, pruned.all()).toBe(0);
      expect(existsSync(readers(root, "forge-reports-job"))).toBe(false);
      // Undo keeps what prune removed.
      expect((await atticus(root, "catalog", "undo", "--yes")).code).toBe(0);
      expect(readFileSync(readers(root, "forge-reports-job"), "utf8")).toBe(slot);
    },
    T,
  );
});

/** A beta.26 Forge metarepo: catalog/generated and catalog/curated, no catalog/sources. */
async function beta26(): Promise<string> {
  const root = await temp("atticus-cs5-beta26-");
  await cp(join(FORGE, "metarepo"), root, { recursive: true });
  await cp(join(BETA26, "catalog"), join(root, "catalog"), { recursive: true });
  return root;
}

/**
 * How fixtures/forge-beta26/ is made (UPDATE_GOLDEN=1 writes it): the Forge golden slots and
 * fixtures/forge-beta26/curated/ built, as beta.26's scan wrote a full catalog with its curated
 * decisions applied; then the slots and build.json taken away, and one hand edit made to a record
 * file, as a team's catalog/generated can have.
 */
async function makeBeta26(): Promise<Record<string, string>> {
  const root = await temp("atticus-cs5-make-beta26-");
  await cp(join(FORGE, "metarepo", "org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(FORGE, "slots", "readers"), join(sources(root), "readers"), { recursive: true });
  await cp(join(BETA26, "curated"), join(root, "catalog", "curated"), { recursive: true });
  const b = await buildAndWrite(root, { command: "atticus catalog build" });
  if (b.guard.refused) throw new Error(b.guard.refused.message);
  await rm(sources(root), { recursive: true });
  const hand = join(generated(root), "setting", "portal-bff.ledger-read-timeout.yaml");
  // Raised by hand after an incident, as a team did before beta.27 (a scan would have undone it).
  await writeFile(
    hand,
    readFileSync(hand, "utf8").replace("valueOrRef: 2000ms", "valueOrRef: 5000ms"),
  );
  const out: Record<string, string> = {};
  for (const [p, t] of Object.entries(files(join(root, "catalog")))) out[`catalog/${p}`] = t;
  return out;
}

describe("atticus upgrade of a beta.26 metarepo: every record adopted, shown first (ADR 0195 point 6)", () => {
  it(
    "fixtures/forge-beta26 is the golden slots' catalog with its curated decision and one hand edit",
    async () => {
      const want = await makeBeta26();
      if (update) {
        await rm(join(BETA26, "catalog"), { recursive: true, force: true });
        for (const [p, t] of Object.entries(want)) {
          await mkdir(dirname(join(BETA26, p)), { recursive: true });
          await writeFile(join(BETA26, p), t);
        }
      }
      const have: Record<string, string> = {};
      for (const [p, t] of Object.entries(files(join(BETA26, "catalog")))) have[`catalog/${p}`] = t;
      expect(have).toEqual(want);
      expect(want["catalog/generated/setting/portal-bff.ledger-read-timeout.yaml"]).toMatch(
        /valueOrRef: 5000ms/,
      );
    },
    T,
  );

  it(
    "the dry run writes no byte and says what it would write; --yes adopts every record and keeps a copy; the first build changes nothing",
    async () => {
      const root = await beta26();
      const old = files(generated(root));
      const curated = files(join(root, "catalog", "curated"));
      expect(Object.keys(old).length).toBeGreaterThan(40);
      // A build refuses over a catalog from before the slots, and says to upgrade.
      const b = await atticus(root, "catalog", "build");
      expect(b.code).toBe(1);
      expect(b.all()).toMatch(/run atticus upgrade/);
      const dry = await atticus(root, "upgrade");
      expect(dry.code, dry.all()).toBe(0);
      const said = dry.out.join("\n");
      expect(said).toMatch(
        new RegExp(
          `Adopt the catalog into source slots \\(ADR 0195\\): ${Object.keys(old).length} records, nothing lost`,
        ),
      );
      expect(said).toMatch(
        /catalog\/sources\/readers\/forge-ledger\.json: \d+ records? \(forge-ledger, legacy\)/,
      );
      expect(said).toMatch(
        /The first build changes nothing: catalog\/generated stays byte for byte/,
      );
      expect(said).toMatch(/atticus upgrade --yes applies this step/);
      expect(existsSync(sources(root))).toBe(false);
      expect(files(generated(root))).toEqual(old);
      const yes = await atticus(root, "upgrade", "--yes");
      expect(yes.code, yes.all()).toBe(0);
      // The copy of the catalog as it was, byte for byte, and the catalog itself unchanged.
      expect(files(join(sources(root), "legacy", "generated-before-upgrade"))).toEqual(old);
      expect(files(generated(root))).toEqual(old);
      expect(files(join(root, "catalog", "curated"))).toEqual(curated);
      // Every record is in exactly one legacy slot.
      const adopted: string[] = [];
      for (const [p, t] of Object.entries(files(sources(root)))) {
        if (!p.endsWith(".json") || p === "build.json") continue;
        const s = JSON.parse(t) as { status?: string; records?: { kind: string; id: string }[] };
        if (!s.records) continue;
        expect(s.status, p).toBe("legacy");
        adopted.push(...s.records.map((r) => `${r.kind}/${r.id}`));
      }
      expect(new Set(adopted).size).toBe(adopted.length);
      expect(adopted.length).toBe(Object.keys(old).length);
      // The first build is lossless, and building again writes nothing; the hand edit is kept.
      const check = await atticus(root, "catalog", "build", "--check");
      expect(check.code, check.all()).toBe(0);
      const again = await atticusJson<{ files: { written: number; removed: number } }>(
        root,
        "catalog",
        "build",
      );
      expect(again.code, again.all()).toBe(0);
      expect(again.json.files).toMatchObject({ written: 0, removed: 0 });
      expect(files(generated(root))).toEqual(old);
      // A second upgrade does nothing.
      expect((await atticus(root, "upgrade", "--yes")).code).toBe(0);
      expect(files(join(sources(root), "legacy", "generated-before-upgrade"))).toEqual(old);
    },
    T,
  );

  it(
    "after the upgrade, a scan of the clones keeps every cross-repo arrow and the curated decision",
    async () => {
      const root = await beta26();
      const old = files(generated(root));
      const arrows = Object.keys(old).filter((p) => p.startsWith("interface/"));
      expect(arrows.length).toBeGreaterThan(0);
      expect((await atticus(root, "upgrade", "--yes")).code).toBe(0);
      for (const id of await readdir(join(FORGE, "repos"))) {
        const dir = join(root, "workspace", id);
        await cp(join(FORGE, "repos", id), dir, { recursive: true });
        git(dir, "init", "-q");
        git(dir, "add", "-A");
        git(dir, "commit", "-q", "-m", "fixture");
      }
      // The Forge dialect's tests read ../repos beside the metarepo.
      await cp(join(FORGE, "repos"), join(dirname(root), "repos"), { recursive: true }).catch(
        () => undefined,
      );
      let r = await atticusJson<ScanReport>(root, "scan", "--no-drift");
      // Replacing a legacy slot by a read is the scan's own result; when it is large it waits.
      if (r.json.refused?.reasons.includes("large-removals"))
        r = await atticusJson<ScanReport>(
          root,
          "scan",
          "--no-drift",
          "--allow-removals",
          String(r.json.refused.allowRemovals),
        );
      expect(r.json.refused, r.all()).toBeUndefined();
      const now = files(generated(root));
      for (const a of arrows) expect(Object.keys(now), a).toContain(a);
      // The curated decision applies to the read that replaced the legacy slot.
      const [decision] = Object.values(files(join(root, "catalog", "curated")));
      const target = /^target: (.+)$/m.exec(decision!)![1]!;
      const asserted = /migration: in-progress/;
      const file = Object.entries(now).find(([, t]) => new RegExp(`^id: ${target}$`, "m").test(t));
      expect(file?.[1]).toMatch(asserted);
    },
    T,
  );
});

describe("atticus repo rename keeps the curated decisions (ADR 0195 point 2)", () => {
  it(
    "the new slot is written before the old one goes, and the decision's effect stays in the catalog",
    async () => {
      const root = await scannedForge();
      await cp(join(BETA26, "curated"), join(root, "catalog", "curated"), { recursive: true });
      const b = await atticus(root, "catalog", "build");
      expect(b.code, b.all()).toBe(0);
      const comp = join(generated(root), "component", "ledger-api.yaml");
      expect(readFileSync(comp, "utf8")).toMatch(/migration: in-progress/);
      const before = readFileSync(readers(root, "forge-ledger"), "utf8");
      let r = await atticus(root, "repo", "rename", "forge-ledger", "forge-ledger-core");
      if (r.code !== 0 && /--allow-removals (\d+)/.test(r.all()))
        r = await atticus(
          root,
          "repo",
          "rename",
          "forge-ledger",
          "forge-ledger-core",
          "--allow-removals",
          /--allow-removals (\d+)/.exec(r.all())![1]!,
        );
      expect(r.code, r.all()).toBe(0);
      expect(existsSync(readers(root, "forge-ledger"))).toBe(false);
      const moved = parseReadersSlot(readFileSync(readers(root, "forge-ledger-core"), "utf8"));
      expect(moved.ok && moved.slot.repo).toBe("forge-ledger-core");
      expect(moved.ok && moved.slot.records.length).toBe(
        (JSON.parse(before) as { records: unknown[] }).records.length,
      );
      expect(readFileSync(comp, "utf8")).toMatch(/migration: in-progress/);
      expect(readFileSync(comp, "utf8")).toMatch(/forge-ledger-core/);
    },
    T,
  );

  // ADR 0195 point 2: the rename writes the build.json of the build it checked, so the records'
  // sources name the new slot paths and the next check has nothing to do.
  it(
    "right after a rename, catalog build --check passes",
    async () => {
      const root = await scannedForge();
      await cp(join(BETA26, "curated"), join(root, "catalog", "curated"), { recursive: true });
      expect((await atticus(root, "catalog", "build")).code).toBe(0);
      const r = await atticus(root, "repo", "rename", "forge-ledger", "forge-ledger-core");
      expect(r.code, r.all()).toBe(0);
      const check = await atticus(root, "catalog", "build", "--check");
      expect(check.code, check.all()).toBe(0);
    },
    T,
  );
});
