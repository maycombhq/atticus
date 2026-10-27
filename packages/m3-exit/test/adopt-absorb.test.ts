import { cp, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ADOPT_FIXTURES, atticus, fingerprint, json, sh, T, walk } from "./helpers.js";

/**
 * M3 exit: "the adopt and absorb bars are met".
 * Adopt bar: `atticus adopt` gives a working setup in under 30 minutes with no hand-written
 * config and changes nothing in the repo; removing Atticus leaves the repo byte-identical apart
 * from Atticus's own folders.
 * Absorb bar: `atticus absorb` lists every item as adopt, link or ignore in under 10 minutes,
 * with at least 90% translated.
 * Measured through the CLI on the adopt package's fixtures (packages/adopt/test/fixtures).
 */

const ADOPT_BAR_MS = 30 * 60 * 1000;
const ABSORB_BAR_MS = 10 * 60 * 1000;

const made: string[] = [];
afterAll(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

async function copy(fixture: string, as: string): Promise<string> {
  const top = await mkdtemp(join(tmpdir(), "atticus-m3-adopt-"));
  made.push(top);
  const dir = join(top, as);
  await cp(join(ADOPT_FIXTURES, fixture), dir, { recursive: true });
  return dir;
}

const ADOPT: [fixture: string, as: string, what: string][] = [
  ["openspec-repo", "catalog-service", "an OpenSpec repo"],
  ["speckit-repo", "order-export", "a Spec Kit repo"],
  ["assistant-repo", "pricing-service", "a repo with its own assistant prompts"],
  ["plain-multi", "shop", "a folder of plain repos"],
];

describe("M3 exit step 4: the adopt bar", () => {
  for (const [fixture, as, what] of ADOPT)
    it(
      `${what} (${fixture}): adopt writes only .atticus/, the setup works with no hand-written config, and unadopt leaves it byte-identical`,
      async () => {
        const dir = await copy(fixture, as);
        sh(dir, "init", "-q", "-b", "main");
        sh(dir, "add", "-A");
        sh(dir, "commit", "-q", "-m", "fixture");
        const before = await fingerprint(dir);
        const started = Date.now();

        const a = await atticus(undefined, "adopt", dir, "--json");
        expect(a.err).toEqual([]);
        expect(a.code).toBe(0);
        const r = json<{ ms: number; problems: unknown[]; written: string[] }>(a);
        expect(r.problems).toEqual([]);
        expect(r.ms).toBeLessThan(ADOPT_BAR_MS);
        // Nothing of the repo changed; everything Atticus wrote is under .atticus/.
        expect(await fingerprint(dir, (rel) => rel === ".atticus")).toEqual(before);
        expect(existsSync(join(dir, ".atticus/org-pack"))).toBe(true);
        expect(
          sh(dir, "status", "--porcelain", "--untracked-files=all")
            .split("\n")
            .filter(Boolean)
            .every((l) => l.startsWith("?? .atticus/")),
        ).toBe(true);

        // A working setup with no hand-written config: the org pack validates, the repo scans,
        // and the zero-install assistant commands are written and checked.
        const v = await atticus(undefined, "orgpack", "validate", join(dir, ".atticus/org-pack"));
        expect(v.code, v.text).toBe(0);
        const s = await atticus(dir, "scan");
        expect(s.code, s.text).toBe(0);
        expect(s.out[0]).toMatch(/^Scanned \d+ repos/);
        const z = await atticus(dir, "assistant-files");
        expect(z.code, z.text).toBe(0);
        expect(Date.now() - started).toBeLessThan(ADOPT_BAR_MS);

        // Removing Atticus: byte-identical, with no .atticus/ left behind.
        const u = await atticus(undefined, "unadopt", dir);
        expect(u.code, u.text).toBe(0);
        expect(u.out.at(-1)).toBe(
          "Atticus is removed; every other file is as it was before adoption.",
        );
        expect(await fingerprint(dir)).toEqual(before);
        expect(sh(dir, "status", "--porcelain", "--untracked-files=all")).toBe("");
      },
      T,
    );

  it(
    "an adopted repo runs the change pipeline in place: change new and the critic work there, and unadopt still restores the repo",
    async () => {
      const dir = await copy("speckit-repo", "order-export");
      sh(dir, "init", "-q", "-b", "main");
      sh(dir, "add", "-A");
      sh(dir, "commit", "-q", "-m", "fixture");
      const before = await fingerprint(dir);
      expect((await atticus(undefined, "adopt", dir)).code).toBe(0);
      const c = await atticus(
        dir,
        "change",
        "new",
        "Export refunds",
        "--type",
        "feature",
        "--by",
        "pat",
        "--id",
        "export-refunds",
      );
      expect(c.code, c.text).toBe(0);
      expect((await atticus(dir, "change", "list")).text).toMatch(/export-refunds/);
      expect(
        (await atticus(dir, "critic", "export-refunds", "--gate", "design")).code,
      ).toBeLessThan(2);
      expect((await atticus(undefined, "unadopt", dir)).code).toBe(0);
      expect(await fingerprint(dir)).toEqual(before);
    },
    T,
  );

  it(
    "change-folder-layout: in a repo adopted in place, change new writes the change under .atticus/openspec (the layout), not openspec/changes at the repo root",
    async () => {
      const dir = await copy("speckit-repo", "order-export");
      sh(dir, "init", "-q", "-b", "main");
      sh(dir, "add", "-A");
      sh(dir, "commit", "-q", "-m", "fixture");
      const before = await fingerprint(dir);
      expect((await atticus(undefined, "adopt", dir)).code).toBe(0);
      expect(
        (
          await atticus(
            dir,
            "change",
            "new",
            "Export refunds",
            "--type",
            "feature",
            "--by",
            "pat",
            "--id",
            "export-refunds",
          )
        ).code,
      ).toBe(0);
      expect(await fingerprint(dir, (rel) => rel === ".atticus")).toEqual(before);
      expect(existsSync(join(dir, ".atticus/openspec/changes/export-refunds/change.yaml"))).toBe(
        true,
      );
    },
    T,
  );
});

interface AbsorbJson {
  format: string;
  summary: { items: number; translatable: number; translated: number; translatedPercent: number };
  items: { id: string; kind: string; path: string; action: string; reason: string }[];
  problems: string[];
  ms: number;
  proposal?: string;
}

const ABSORB: [fixture: string, id: string, what: string][] = [
  ["critic-prompts", "design-review", "a team's critic prompts (plain Markdown and YAML)"],
  ["speckit-repo", "order-team", "a Spec Kit repo"],
  ["assistant-repo", "pricing-team", "a repo with Claude Code and Copilot prompts"],
  ["openspec-repo", "catalog-team", "an OpenSpec repo"],
  ["atticus-metarepo", "payments", "another Atticus metarepo"],
];

describe("M3 exit step 4: the absorb bar", () => {
  for (const [fixture, id, what] of ABSORB)
    it(
      `${what} (${fixture}): every item is listed as adopt, link or ignore, at least 90% translated, under 10 minutes, the org pack is unchanged and the source is byte-identical`,
      async () => {
        const top = await mkdtemp(join(tmpdir(), "atticus-m3-absorb-"));
        made.push(top);
        const root = join(top, "shop-meta");
        expect((await atticus(undefined, "init", root, "--platform", "shop")).code).toBe(0);
        const pack = await fingerprint(join(root, "org-pack"));

        // The source is a copy, and its whole tree is fingerprinted: absorb was asked to read
        // it, so nothing of ours — a record cache, a .gitignore, a lock — may land in it
        // (hard rule 6, ADR 0038, ADR 0119 addendum).
        const src = await copy(fixture, fixture);
        const source = await fingerprint(src);
        const a = await atticus(root, "absorb", src, "--id", id, "--json");
        expect(a.code, a.text).toBe(0);
        const r = json<AbsorbJson>(a);
        expect(r.problems).toEqual([]);
        expect(r.ms).toBeLessThan(ABSORB_BAR_MS);
        for (const item of r.items) {
          expect(["adopt", "link", "ignore"]).toContain(item.action);
          expect(item.reason.length, item.id).toBeGreaterThan(10);
        }
        // Every file of the source is in some item (a file, a folder, or the counted code),
        // apart from this machine's own files inside a metarepo's .atticus/ (LOCAL_ONLY: the
        // kept parses, logs, locks, me.yaml), which absorb leaves out: they are its state, not
        // its content. A test that reads a fixture in place can leave them there.
        const files = (await walk(src)).filter((f) => !/(^|\/)\.atticus\//.test(`/${f}`));
        const covered = (f: string) =>
          r.items.some((x) => x.kind !== "code" && (x.path === f || f.startsWith(`${x.path}/`)));
        const code = r.items.find((x) => x.kind === "code");
        const rest = files.filter((f) => !covered(f));
        expect(rest.length, `not listed: ${rest.join(", ")}`).toBe(
          code ? Number(code.id.split(":")[1]!.split("-")[0]) : 0,
        );
        expect(r.summary.translatedPercent).toBeGreaterThanOrEqual(90);
        expect(r.summary.translated / Math.max(1, r.summary.translatable)).toBeGreaterThanOrEqual(
          0.9,
        );
        // A proposal for a person to review; nothing in the org pack changed.
        expect(r.proposal).toBe(`proposals/absorb/${id}`);
        expect(existsSync(join(root, r.proposal!, "PR.md"))).toBe(true);
        expect(await fingerprint(join(root, "org-pack"))).toEqual(pack);
        // And the source, every file and every byte of it, is as it was.
        expect(await fingerprint(src)).toEqual(source);
      },
      T,
    );
});

describe("atticus init through the command line", () => {
  it(
    "init-path: atticus init <path> --platform shop names the org pack after the folder, not the whole path",
    async () => {
      const top = await mkdtemp(join(tmpdir(), "atticus-m3-init-"));
      made.push(top);
      const r = await atticus(undefined, "init", join(top, "shop-meta"), "--platform", "shop");
      expect(r.text).not.toMatch(/can't be an org pack name/);
      expect(r.code).toBe(0);
    },
    T,
  );
});
