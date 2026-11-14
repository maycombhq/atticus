import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { acquireLock, parseRecord } from "@maycombhq/core";
import { verifyCommand } from "../src/verify-commands.js";
import { confirmed, seedReadersSlots } from "./seed-slots.js";

/**
 * The hunt of beta.28.1 (F1, N2): a partial Apply keeps provenance honest. Facts read at another
 * commit than the clone's are never written under it (every fact rejected, or any rejected as
 * read at another commit, refuses the write as before beta.28.1, saying to read the repo again
 * at this commit); a clone with no `.git` of its own never takes the metarepo's HEAD as its
 * commit; and a partial write refused (the scan's lock held) still points at the facts to fix.
 * The invented Forge metarepo of the verify fixtures.
 */

const VERIFY = join(__dirname, "..", "..", "verify", "test", "fixtures");
const META = join(VERIFY, "metarepo");
const T = 120_000;

async function metarepo(facts?: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "atticus-provenance-"));
  cpSync(join(META, "org-pack"), join(root, "org-pack"), { recursive: true });
  cpSync(join(META, "catalog"), join(root, "catalog"), { recursive: true });
  cpSync(join(VERIFY, "repo"), join(root, "workspace", "forge-ledger"), { recursive: true });
  const raw = (parse(readFileSync(join(META, "scan-before.yaml"), "utf8")) as object[]).map((x) => {
    const p = parseRecord({ schemaVersion: 2, status: "current", ...x });
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    return p.record;
  });
  await seedReadersSlots(root, raw);
  mkdirSync(join(root, "facts"), { recursive: true });
  writeFileSync(
    join(root, "facts", "forge-ledger.jsonl"),
    facts ?? readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8"),
  );
  return root;
}
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};
const dirOf = (root: string) => join(root, "workspace", "forge-ledger");
const write = (root: string, commit: string, o = io()) =>
  verifyCommand(root, "forge-ledger", { commit, dir: dirOf(root), write: true }, o.io);
/** The first Apply, confirmed as a person confirms the readers' records it replaces. */
const first = (root: string) =>
  confirmed(
    (x, allowRemovals) =>
      verifyCommand(
        root,
        "forge-ledger",
        {
          commit: "0123abc",
          dir: dirOf(root),
          write: true,
          ...(allowRemovals !== undefined ? { allowRemovals } : {}),
        },
        x,
      ),
    io().io,
  );
const tree = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true }))
      if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`);
      else out[`${rel}${e.name}`] = readFileSync(join(d, e.name), "utf8");
  };
  walk(dir, "");
  return out;
};
const catalog = (root: string) => ({
  ...tree(join(root, "catalog")),
  ...Object.fromEntries(
    Object.entries(tree(join(root, "specs"))).map(([k, v]) => [`specs/${k}`, v]),
  ),
});
const badFact = () => readFileSync(join(VERIFY, "redteam.facts.jsonl"), "utf8").split("\n")[0]!;

describe("an Apply never stamps a commit its facts weren't verified at (F1)", () => {
  it(
    "facts read at an earlier commit, Applied at a new one: refused, read it again at this commit",
    async () => {
      const root = await metarepo();
      expect(await first(root)).toBe(0);
      const before = catalog(root);
      const o = io();
      expect(await write(root, "fedcba9", o)).toBe(1);
      const said = [...o.out, ...o.err].join("\n");
      expect(said).toMatch(/Nothing written/);
      expect(said).toMatch(
        /read at another commit than fedcba9: read forge-ledger again at this commit/,
      );
      expect(said).not.toMatch(/left out: /);
      expect(catalog(root)).toEqual(before);
      // A full sha is said as its first 12 characters.
      const long = io();
      expect(await write(root, "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12", long)).toBe(1);
      const longSaid = [...long.out, ...long.err].join("\n");
      expect(longSaid).toContain("read at another commit than ab12cd34ef56: read forge-ledger");
      expect(longSaid).not.toContain("than ab12cd34ef56ab12cd34");
      const meta = JSON.parse(
        readFileSync(join(root, "catalog", "sources", "facts", "forge-ledger.meta.json"), "utf8"),
      ) as { commit: string };
      expect(meta.commit).toBe("0123abc");
    },
    T,
  );

  it(
    "every fact rejected: refused as before beta.28.1, nothing written",
    async () => {
      const root = await metarepo(badFact() + "\n");
      const before = catalog(root);
      const o = io();
      expect(await write(root, "0123abc", o)).toBe(1);
      expect(o.err.join("\n")).toMatch(/Nothing written: 1 fact was rejected/);
      expect(o.err.join("\n")).toMatch(/every fact of the read was rejected/);
      expect(catalog(root)).toEqual(before);
    },
    T,
  );

  it(
    "a clone with no .git of its own never takes the metarepo's HEAD as its commit",
    async () => {
      const root = await metarepo();
      const git = (...a: string[]) =>
        execFileSync("git", a, { cwd: root, stdio: "pipe" }).toString().trim();
      git("init", "-q");
      git(
        "-c",
        "user.email=pat@forge.example",
        "-c",
        "user.name=Pat",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "metarepo",
      );
      const head = git("rev-parse", "HEAD");
      const o = io();
      await verifyCommand(root, "forge-ledger", { dir: dirOf(root), write: true }, o.io);
      const said = [...o.out, ...o.err].join("\n");
      expect(said).toMatch(
        /can't tell forge-ledger's commit: workspace\/forge-ledger has no \.git of its own/,
      );
      expect(said).not.toContain(head);
      const metaFile = join(root, "catalog", "sources", "facts", "forge-ledger.meta.json");
      if (existsSync(metaFile)) expect(readFileSync(metaFile, "utf8")).not.toContain(head);
    },
    T,
  );
});

describe("a partial write refused still points at the facts to fix (N2)", () => {
  it(
    "the scan's lock held: the facts left out and their file are said with the refusal",
    async () => {
      const root = await metarepo();
      expect(await first(root)).toBe(0);
      const facts = join(root, "facts", "forge-ledger.jsonl");
      writeFileSync(facts, readFileSync(facts, "utf8") + badFact() + "\n");
      const held = await acquireLock(root, "scan", "atticus scan");
      try {
        const o = io();
        expect(await write(root, "0123abc", o)).toBe(1);
        const said = [...o.out, ...o.err].join("\n");
        expect(said).toMatch(/rt-no-file/);
        expect(said).toMatch(/Fix them from facts\/forge-ledger\.rejected\.jsonl/);
      } finally {
        await held.release();
      }
    },
    T,
  );
});

describe("a pairing on a fact left out says it waits (F5)", () => {
  it(
    "a call left out because the entry it names was rejected: its pairing waits on that entry",
    async () => {
      // No Apply before: no earlier copy of the call is kept, so its pairing isn't drawn.
      const root = await metarepo();
      const facts = join(root, "facts", "forge-ledger.jsonl");
      const lines = readFileSync(facts, "utf8").split("\n").filter(Boolean);
      // The entry the notify call is made from, cited on a line past the file's end.
      const broken = lines.map((l) => {
        const f = JSON.parse(l) as { id: string; cite: { line: number } };
        return f.id === "e-post-entry"
          ? JSON.stringify({ ...f, cite: { ...f.cite, line: 900 } })
          : l;
      });
      writeFileSync(facts, broken.join("\n") + "\n");
      const notify = JSON.parse(lines.find((l) => l.includes('"id":"c-notify"'))!) as {
        cite: { file: string; line: number; value: string };
      };
      writeFileSync(
        join(root, "facts", "forge-ledger.corrections.jsonl"),
        JSON.stringify({
          schemaVersion: 1,
          fact: "c-notify",
          target: {
            kind: "call",
            file: notify.cite.file,
            line: notify.cite.line,
            value: notify.cite.value,
          },
          action: "link",
          link: { repo: "forge-payments", method: "POST", path: "/notify" },
          by: "pat",
          at: "2026-11-14T10:00:00Z",
        }) + "\n",
      );
      const said: string[] = [];
      const code = await confirmed(
        (x, allowRemovals) =>
          verifyCommand(
            root,
            "forge-ledger",
            {
              commit: "0123abc",
              dir: dirOf(root),
              write: true,
              ...(allowRemovals !== undefined ? { allowRemovals } : {}),
            },
            x,
          ),
        { out: (l) => said.push(l), err: (l) => said.push(l) },
      );
      const text = said.join("\n");
      expect(code, text).toBe(3);
      expect(text).not.toMatch(/isn't a correction/);
      expect(text).toMatch(/left out: c-notify \(ref-rejected\)/);
      expect(text).toContain(
        "Your pairing of c-notify waits on e-post-entry being put back (fix it in facts/forge-ledger.jsonl).",
      );
    },
    T,
  );
});
