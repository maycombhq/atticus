import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { BUILD_MANIFEST_READS, buildManifestPath } from "@maycombhq/scanner";
import { buildQuestion, CONFIRM_WORDS, confirmOnce, isYes } from "../src/confirm-once.js";
import { main } from "../src/main.js";

/**
 * ADR 0202 point 9: in a terminal, `atticus upgrade` and a refused build ask once instead of
 * having the command typed again with a count. The reader is injected (`Output.ask`): a test
 * never waits on a terminal. Without it, with `--json` and under `CI` nothing is asked and every
 * line is what it was. Invented Forge estate (CLAUDE.md rule 3).
 */

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");
const T = 300_000;
const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })));
});

type Ask = (question: string) => Promise<string | undefined>;
/** What says a command isn't a person's own: cleared for a run, so the test's own shell (an
 * assistant's, a CI's) never decides whether a question is asked. */
const NOT_A_PERSON = [
  "CI",
  "CLAUDECODE",
  "GEMINI_CLI",
  "CURSOR_AGENT",
  "ATTICUS_ASSISTANT",
  "ATTICUS_ACP_SESSION",
  "ATTICUS_STARTED_BY",
];
async function run(argv: string[], ask?: Ask, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const kept = Object.fromEntries(
    [...NOT_A_PERSON, ...Object.keys(env)].map((k) => [k, process.env[k]]),
  );
  for (const k of NOT_A_PERSON) delete process.env[k];
  Object.assign(process.env, env);
  try {
    const code = await main(argv, {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      ...(ask
        ? {
            ask: async (q: string) => {
              asked.push(q);
              return ask(q);
            },
          }
        : {}),
    });
    return { code, out, err, asked };
  } finally {
    for (const [k, v] of Object.entries(kept))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}

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
const generated = (root: string) => files(join(root, "catalog", "generated"));

let template: string | undefined;
/** The Forge metarepo built from its golden readers slots, upgraded by this Atticus. */
async function built(): Promise<string> {
  if (!template) {
    const t = await mkdtemp(join(tmpdir(), "b30-st-confirm-"));
    made.push(t);
    await cp(join(FORGE, "metarepo"), t, { recursive: true });
    await cp(join(FORGE, "slots", "readers"), join(t, "catalog/sources/readers"), {
      recursive: true,
    });
    for (const argv of [
      ["upgrade", "--by", "pat"],
      ["catalog", "build"],
    ]) {
      const r = await run([...argv, "--root", t]);
      expect(r.code, r.err.join("\n")).toBe(0);
    }
    template = t;
  }
  const root = await mkdtemp(join(tmpdir(), "b30-st-confirm-copy-"));
  made.push(root);
  await cp(template, root, { recursive: true });
  return root;
}
const MANIFEST = "org-pack/profiles/forge/repos.manifest.yaml";
/** A repo leaves the manifests: the next build removes its records, more than the limit. */
async function largeRemoval(root: string): Promise<void> {
  const text = await readFile(join(root, MANIFEST), "utf8");
  const next = text.replace(/ {2}- id: forge-reports-job\n(?: {4}.*\n)+/, "");
  expect(next).not.toBe(text);
  await writeFile(join(root, MANIFEST), next);
}
/** A record file changed by hand; returns its path under catalog/generated. */
async function handEdit(root: string, nth = 0): Promise<string> {
  const dir = join(root, "catalog", "generated", "system");
  const name = (await readdir(dir)).sort()[nth]!;
  const p = join(dir, name);
  await writeFile(p, `${await readFile(p, "utf8")}# edited by hand\n`);
  return `system/${name}`;
}
const count = (lines: string[], flag: string) =>
  Number(new RegExp(`--${flag} (\\d+)`).exec(lines.join("\n"))?.[1]);
const yes: Ask = async () => "y";
const no: Ask = async () => "n";

describe("only y or yes is yes", () => {
  it("in any case; Enter, anything else and the end of input are no", async () => {
    for (const a of ["y", "Y", "yes", "YES", " Yes "]) expect(isYes(a), a).toBe(true);
    for (const a of ["", "n", "no", "yes please", "yy", "1", "true", undefined])
      expect(isYes(a), String(a)).toBe(false);
    expect(await confirmOnce({}, "Remove these 3 records? [y/N]")).toBe(false);
    expect(await confirmOnce({ ask: async () => undefined }, "x")).toBe(false);
    expect(await confirmOnce({ ask: async () => "YES" }, "x")).toBe(true);
  });

  it("a refusal is asked about only when its list is one a person can confirm", () => {
    const r = { message: "" };
    expect(buildQuestion({ ...r, reasons: ["large-removals"], allowRemovals: 7 })).toEqual({
      question: "Remove these 7 records? [y/N]",
      counts: { allowRemovals: 7 },
    });
    expect(buildQuestion({ ...r, reasons: ["hand-edits"], discardEdits: 2 })).toEqual({
      question: "Discard these 2 hand edits? A copy is kept for atticus catalog undo. [y/N]",
      counts: { discardEdits: 2 },
    });
    expect(
      buildQuestion({
        ...r,
        reasons: ["hand-edits", "large-removals"],
        discardEdits: 2,
        allowRemovals: 7,
      }),
    ).toEqual({
      question: "Discard these 2 hand edits and remove these 7 records? [y/N]",
      counts: { allowRemovals: 7, discardEdits: 2 },
    });
    for (const reasons of [
      ["unexplained-removals"],
      ["newer-atticus"],
      ["not-upgraded"],
      ["nothing-read"],
      ["empty"],
      ["large-removals", "unexplained-removals"],
      ["hand-edits", "not-upgraded"],
    ] as const)
      expect(
        buildQuestion({ ...r, reasons: [...reasons], allowRemovals: 7, discardEdits: 2 }),
        reasons.join(),
      ).toBeUndefined();
    // A build.json that doesn't read keeps its typed count.
    expect(
      buildQuestion({ ...r, reasons: ["hand-edits"], discardEdits: 40, unreadableManifest: true }),
    ).toBeUndefined();
  });
});

describe("a refused build asks once in a terminal (ADR 0202 point 9)", () => {
  it(
    "large removals: yes writes exactly those, no writes nothing; without a terminal the lines are today's",
    async () => {
      const root = await built();
      await largeRemoval(root);
      const before = generated(root);
      // Without a terminal: the refusal as it always was, with the command to type.
      const plain = await run(["catalog", "build", "--root", root]);
      expect(plain.code).toBe(1);
      expect(plain.asked).toEqual([]);
      const n = count(plain.err, "allow-removals");
      expect(n).toBeGreaterThan(0);
      expect(plain.err.join("\n")).toContain(
        `Confirm exactly these: atticus catalog build --allow-removals ${n}.`,
      );
      expect(plain.err.join("\n")).not.toContain("Nothing written.");
      // With one, and --json or CI: nothing is asked, and the lines are the same.
      for (const [argv, env] of [
        [["--json"], {}],
        [[], { CI: "true" }],
      ] as const) {
        const r = await run(["catalog", "build", ...argv, "--root", root], yes, env);
        expect(r.code).toBe(1);
        expect(r.asked).toEqual([]);
        if (!argv.length) expect(r.err).toEqual(plain.err);
      }
      expect(generated(root)).toEqual(before);
      // In a terminal: asked once, after the list; no leaves everything as it was.
      const refused = await run(["catalog", "build", "--root", root], no);
      expect(refused.asked).toEqual([`Remove these ${n} records? [y/N]`]);
      expect(refused.code).toBe(1);
      // The metarepo is up to date, so no line about where it stands follows the refusal.
      expect(plain.err.at(-1)).toBe(
        `Confirm exactly these: atticus catalog build --allow-removals ${n}.`,
      );
      expect(plain.err.join("\n")).not.toContain("You are on Atticus");
      expect(refused.err).toEqual([...plain.err, "Nothing written."]);
      // An assistant's session, the app or an editor's extension can't answer: none is asked,
      // though a terminal is there (the review: the question waited for ever under a pty).
      for (const env of [
        { ATTICUS_ACP_SESSION: "1" },
        { CURSOR_AGENT: "1" },
        { CLAUDECODE: "1" },
        { GEMINI_CLI: "1" },
        { ATTICUS_ASSISTANT: "forge-bot" },
        { ATTICUS_STARTED_BY: "vscode" },
        { ATTICUS_STARTED_BY: "intellij" },
      ] as Record<string, string>[]) {
        const r = await run(["catalog", "build", "--root", root], yes, env);
        expect(r.asked, JSON.stringify(env)).toEqual([]);
        expect(r.code, JSON.stringify(env)).not.toBe(0);
      }
      expect(generated(root)).toEqual(before);
      expect(generated(root)).toEqual(before);
      // Enter and the end of input are no.
      for (const a of ["", undefined]) {
        const r = await run(["catalog", "build", "--root", root], async () => a);
        expect(r.code).toBe(1);
        expect(r.err).toContain("Nothing written.");
      }
      expect(generated(root)).toEqual(before);
      // The count given by hand is never asked about.
      const typed = await run(
        ["catalog", "build", "--allow-removals", String(n + 1), "--root", root],
        yes,
      );
      expect(typed.asked).toEqual([]);
      expect(typed.code).toBe(1);
      // Yes: the same command with the count listed.
      const ok = await run(["catalog", "build", "--root", root], async () => "Yes");
      expect(ok.asked).toEqual([`Remove these ${n} records? [y/N]`]);
      expect(ok.code, ok.err.join("\n")).toBe(0);
      expect(ok.err.join("\n")).not.toContain("You are on Atticus");
      expect(Object.keys(generated(root)).length).toBeLessThan(Object.keys(before).length);
      // Nothing more to confirm.
      const again = await run(["catalog", "build", "--root", root], yes);
      expect(again).toMatchObject({ code: 0, asked: [] });
    },
    T,
  );

  it(
    "hand edits, and both at once in one question",
    async () => {
      const root = await built();
      const edited = await handEdit(root);
      const refused = await run(["catalog", "build", "--root", root], no);
      expect(refused.asked).toEqual([
        "Discard these 1 hand edits? A copy is kept for atticus catalog undo. [y/N]",
      ]);
      expect(refused.code).toBe(1);
      expect(generated(root)[edited]).toContain("# edited by hand");
      await largeRemoval(root);
      const plain = await run(["catalog", "build", "--root", root]);
      const m = count(plain.err, "allow-removals");
      const both = await run(["catalog", "build", "--root", root], yes);
      expect(both.asked).toEqual([
        `Discard these 1 hand edits and remove these ${m} records? [y/N]`,
      ]);
      expect(both.code, both.err.join("\n")).toBe(0);
      expect(generated(root)[edited] ?? "").not.toContain("# edited by hand");
    },
    T,
  );

  it(
    "a list that changed between the listing and the answer writes nothing",
    async () => {
      const root = await built();
      await handEdit(root, 0);
      const before = generated(root);
      let after: Record<string, string> = {};
      const r = await run(["catalog", "build", "--root", root], async () => {
        // While the question waits, another file is changed by hand, and the first put back.
        const dir = join(root, "catalog", "generated", "system");
        const [first, second] = (await readdir(dir)).sort();
        const text = await readFile(join(dir, first!), "utf8");
        await writeFile(join(dir, first!), text.replace("# edited by hand\n", ""));
        await writeFile(
          join(dir, second!),
          `${await readFile(join(dir, second!), "utf8")}# other\n`,
        );
        after = generated(root);
        return "y";
      });
      expect(r.asked).toHaveLength(1);
      expect(r.code).toBe(1);
      expect(r.err.join("\n")).toContain(
        "isn't what the page listed any more (another command wrote meanwhile)",
      );
      expect(after).not.toEqual(before);
      expect(generated(root)).toEqual(after);
    },
    T,
  );

  it(
    "never asks where one command is the answer: a newer Atticus's catalog, a catalog not upgraded, a build.json that doesn't read",
    async () => {
      const newer = await built();
      await writeFile(
        buildManifestPath(newer),
        `${JSON.stringify({ version: BUILD_MANIFEST_READS + 1, files: [] }, null, 2)}\n`,
      );
      const a = await run(["catalog", "build", "--root", newer], yes);
      expect(a).toMatchObject({ code: 1, asked: [] });
      const old = await built();
      await rm(join(old, "catalog", "sources"), { recursive: true });
      await rm(join(old, ".index", "build-undo"), { recursive: true, force: true });
      const b = await run(["catalog", "build", "--root", old], yes);
      expect(b).toMatchObject({ code: 1, asked: [] });
      // v30 slice 8: what happened, nothing changed, then the command.
      expect(b.err.join("\n")).toMatch(
        /was written before beta\.27[^\n]*\nNothing was changed\.\nMove its \d+ record files[^\n]*: atticus upgrade/,
      );
      const unread = await built();
      // No undo copy names its files either, so none can be told from a hand edit.
      await rm(join(unread, ".index", "build-undo"), { recursive: true, force: true });
      await writeFile(buildManifestPath(unread), "{ this is not json\n");
      const c = await run(["catalog", "build", "--root", unread], yes);
      expect(c).toMatchObject({ code: 1, asked: [] });
      expect(c.err.join("\n")).toMatch(/--discard-edits \d+/);
    },
    T,
  );
});

describe("atticus upgrade asks once about the slots step", () => {
  /** A catalog from before the slots: the build's own files, with catalog/sources taken away. */
  async function beforeSlots(): Promise<string> {
    const root = await built();
    await rm(join(root, "catalog", "sources"), { recursive: true });
    await rm(join(root, ".index", "build-undo"), { recursive: true, force: true });
    return root;
  }

  it(
    "a step that changes no record file: Apply this step? yes is --yes, no leaves it listed",
    async () => {
      const root = await beforeSlots();
      const before = generated(root);
      const plain = await run(["upgrade", "--by", "pat", "--root", root]);
      expect(plain).toMatchObject({ code: 0, asked: [] });
      expect(plain.out.join("\n")).toContain("The first build changes nothing");
      expect(plain.out.at(-1)).toBe(
        "Nothing of it written yet: atticus upgrade --yes applies this step.",
      );
      const refused = await run(["upgrade", "--by", "pat", "--root", root], no);
      expect(refused.asked).toEqual([CONFIRM_WORDS.apply]);
      expect(refused.asked[0]).toBe("Apply this step? It changes no record file. [y/N]");
      expect(refused.code).toBe(0);
      expect(refused.out.at(-1)).toBe("Nothing written.");
      // The list is printed before the question, as it is today.
      expect(refused.out.slice(0, -1)).toEqual(plain.out.slice(0, -1));
      expect(existsSync(join(root, "catalog", "sources"))).toBe(false);
      const ok = await run(["upgrade", "--by", "pat", "--root", root], yes);
      expect(ok.asked).toEqual([CONFIRM_WORDS.apply]);
      expect(ok.code, ok.err.join("\n")).toBe(0);
      expect(ok.out.at(-1)).toBe(
        "Done: the catalog is moved into catalog/sources/ (atticus catalog undo takes it back).",
      );
      expect(ok.out.join("\n")).toContain("Recorded Atticus");
      expect(existsSync(buildManifestPath(root))).toBe(true);
      expect(generated(root)).toEqual(before);
      // Nothing waits any more, so nothing is asked.
      expect(await run(["upgrade", "--by", "pat", "--root", root], yes)).toMatchObject({
        code: 0,
        asked: [],
      });
    },
    T,
  );

  it(
    "declined after another step ran: nothing of this step, and what was written is said above it",
    async () => {
      const root = await beforeSlots();
      // Another step waits too (this machine's ignore file is gone): it runs before the question.
      await rm(join(root, ".atticus", ".gitignore"));
      const r = await run(["upgrade", "--by", "pat", "--root", root], no);
      expect(r.asked).toEqual([CONFIRM_WORDS.apply]);
      expect(r.code).toBe(0);
      expect(r.out.some((l) => l.startsWith("Done: "))).toBe(true);
      expect(r.out.some((l) => l.startsWith("Recorded Atticus "))).toBe(true);
      expect(r.out.at(-1)).toBe("Nothing of this step written.");
      expect(r.out).not.toContain("Nothing written.");
      expect(existsSync(join(root, "catalog", "sources"))).toBe(false);
    },
    T,
  );

  it(
    "a step whose first build changes N files: Accept these N? yes is --yes --accept-changes N",
    async () => {
      const root = await beforeSlots();
      await handEdit(root);
      const plain = await run(["upgrade", "--by", "pat", "--yes", "--root", root]);
      expect(plain.code).toBe(1);
      const n = count([...plain.out, ...plain.err], "accept-changes");
      expect(n).toBeGreaterThan(0);
      // --json and CI are never asked.
      expect(await run(["upgrade", "--by", "pat", "--json", "--root", root], yes)).toMatchObject({
        asked: [],
      });
      expect(await run(["upgrade", "--by", "pat", "--root", root], yes, { CI: "1" })).toMatchObject(
        { asked: [] },
      );
      const refused = await run(["upgrade", "--by", "pat", "--yes", "--root", root], no);
      expect(refused.asked).toEqual([`Accept these ${n}? [y/N]`]);
      expect(refused.code).toBe(1);
      expect(refused.out.at(-1)).toBe("Nothing written.");
      expect(existsSync(join(root, "catalog", "sources"))).toBe(false);
      // A count typed is never asked about.
      const typed = await run(
        ["upgrade", "--by", "pat", "--yes", "--accept-changes", String(n + 1), "--root", root],
        yes,
      );
      expect(typed).toMatchObject({ code: 1, asked: [] });
      const ok = await run(["upgrade", "--by", "pat", "--root", root], yes);
      expect(ok.asked).toEqual([`Accept these ${n}? [y/N]`]);
      expect(ok.code, ok.err.join("\n")).toBe(0);
      expect(existsSync(buildManifestPath(root))).toBe(true);
    },
    T,
  );
});
