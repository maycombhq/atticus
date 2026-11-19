import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readBuildReport } from "@maycombhq/scanner";
import { main } from "../src/main.js";
import { upgradeCheck, upgradeCommand } from "../src/upgrade.js";

/**
 * ADR 0124 addendum E-ids (the owner, 2026-11-19): an Unresolved record's id carries its repo,
 * `unresolved.<repo>.<fact id>`, and one upgrade step names the loose ends of a metarepo an
 * earlier Atticus built again, with every decision and change that cites one carried to its new
 * id. And ADR 0195's beta.28.1 addendum, its sub-addendum of the same day: a call to `${NAME}`
 * that nothing sets is asked about, as `@name@` is, so the arrow beta.28.5 drew by its path goes.
 *
 * fixtures/upgrade-b30/unresolved-ids/metarepo is a metarepo as 2.0.0-beta.28.5 built it (its
 * README says what it holds). After `atticus upgrade`: every record but the loose ends and that
 * arrow is byte for byte as it was; each loose end is under its new id, forge-payments' `c-1`
 * (which had no record) has its own; the suppress decisions and the change name the new ids; the
 * guard asked nothing; a second upgrade has nothing to do; `atticus catalog undo` puts it back.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../../../fixtures/upgrade-b30/unresolved-ids/metarepo");
const B30 = "2.0.0-beta.30";
const T = 300_000;
const STEP = "unresolved-ids-repo";
const TOKEN_ARROW = "interface/if-c0d5c0713cf14dc4.yaml";

const quiet = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};
const roots: string[] = [];
afterAll(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});
async function metarepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "b30-ids-"));
  roots.push(dir);
  const root = join(dir, "forge");
  await cp(FIXTURE, root, { recursive: true });
  return root;
}
/** Every file under a folder, by its path relative to it, with its text. */
async function files(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.set(relative(dir, p).split(sep).join("/"), await readFile(p, "utf8"));
    }
  };
  await walk(dir);
  return out;
}
const generated = (root: string) => files(join(root, "catalog", "generated"));
const unresolvedIds = (m: Map<string, string>) =>
  [...m.keys()]
    .filter((p) => p.startsWith("unresolved/"))
    .map((p) => p.slice("unresolved/".length).replace(/\.yaml$/, ""))
    .sort();
const target = async (root: string, id: string) =>
  (
    parse(await readFile(join(root, "catalog/curated/curateddecision", `${id}.yaml`), "utf8")) as {
      target: string;
    }
  ).target;

describe("atticus upgrade names every loose end again with its repo (ADR 0124 addendum E-ids)", () => {
  it("lists the step on a metarepo beta.28.5 built", async () => {
    const root = await metarepo();
    const c = await upgradeCheck(root, B30);
    const step = c.pending.find((p) => p.id === STEP);
    expect(step?.files).toEqual(
      expect.arrayContaining([
        "catalog/generated/unresolved/unresolved.c-1.yaml",
        "catalog/curated/curateddecision/dec-suppress-risk.yaml",
        "openspec/changes/rates-from-ledger/change.yaml",
      ]),
    );
  });

  it(
    "renames them as moves, carries every id that cites one, asks nothing, and undoes",
    async () => {
      const root = await metarepo();
      const before = await generated(root);
      const curatedBefore = await files(join(root, "catalog", "curated"));
      const changeBefore = await readFile(
        join(root, "openspec/changes/rates-from-ledger/change.yaml"),
        "utf8",
      );
      expect(unresolvedIds(before)).toEqual([
        "unresolved.c-1",
        "unresolved.c-solo",
        "unresolved.forge-notify.on-forge-payments-settled",
      ]);

      const q = quiet();
      expect(await upgradeCommand(root, { by: "pat" }, q.io, B30), q.err.join("\n")).toBe(0);
      // The guard asked nothing: no count to confirm, nothing refused.
      expect([...q.out, ...q.err].join("\n")).not.toMatch(/--allow-removals|refus/i);
      const after = await generated(root);

      // Each loose end under its repo's id; forge-payments' c-1 has a record of its own now, and
      // the call to ${FORGE_LEDGER_URL} is one (asked), no longer an arrow.
      expect(unresolvedIds(after)).toEqual([
        "unresolved.forge-ledger.c-1",
        "unresolved.forge-ledger.c-solo",
        "unresolved.forge-notify.forge-notify.on-forge-payments-settled",
        "unresolved.forge-payments.c-1",
        "unresolved.forge-payments.c-token",
      ]);
      expect(after.has(TOKEN_ARROW)).toBe(false);
      expect(before.get(TOKEN_ARROW)).toMatch(/joined-by-path/);
      // The old record's text, its id aside, under its new id.
      expect(after.get("unresolved/unresolved.forge-ledger.c-1.yaml")).toBe(
        before
          .get("unresolved/unresolved.c-1.yaml")!
          .replace("id: unresolved.c-1\n", "id: unresolved.forge-ledger.c-1\n"),
      );
      // Every other record is byte for byte as it was, but the feature that listed the arrow.
      const arrowId = TOKEN_ARROW.slice("interface/".length, -".yaml".length);
      const named = [...before].filter(([, t]) => t.includes(arrowId)).map(([p]) => p);
      expect(named).toEqual(["capability/feature.statement-payments.yaml", TOKEN_ARROW]);
      const others = (m: Map<string, string>) =>
        [...m].filter(([p]) => !p.startsWith("unresolved/") && !named.includes(p));
      expect(others(after)).toEqual(others(before));
      expect(after.get(named[0]!)).toBe(
        before.get(named[0]!)!.replace(new RegExp(`\\n *- ${arrowId}(?=\\n)`), ""),
      );

      // The decisions and the change carried to the new ids. A decision of a loose end that two
      // repos had under one id is carried to each, so what the person took off the map stays off.
      expect(await target(root, "dec-suppress-risk")).toBe("unresolved.forge-ledger.c-risk");
      expect(await target(root, "dec-suppress-fees")).toBe("unresolved.forge-notify.c-7");
      expect(await target(root, "dec-suppress-fees-forge-payments")).toBe(
        "unresolved.forge-payments.c-7",
      );
      expect(after.has("unresolved/unresolved.forge-notify.c-7.yaml")).toBe(false);
      expect(after.has("unresolved/unresolved.forge-payments.c-7.yaml")).toBe(false);
      const change = parse(
        await readFile(join(root, "openspec/changes/rates-from-ledger/change.yaml"), "utf8"),
      ) as { touches: { records: string[] } };
      // The change named the record beta.28.5 had, which cited forge-ledger's call only.
      expect(change.touches.records).toEqual([
        "unresolved.forge-ledger.c-1",
        "unresolved.forge-ledger.c-solo",
        "unresolved.forge-notify.forge-notify.on-forge-payments-settled",
      ]);

      // The build listed the renames as moves (counted toward no limit) and the arrow's removal
      // with why: the guard explained every one.
      const report = await readBuildReport(root);
      expect(report?.outcome).toBe("written");
      const removed = new Map((report?.removed ?? []).map((x) => [x.id, x.explainedBy]));
      expect(removed.get("unresolved.c-1")?.[0]).toBe(
        "renamed Unresolved/unresolved.forge-ledger.c-1 (the repo in its id)",
      );
      expect(removed.get("unresolved.forge-notify.on-forge-payments-settled")?.[0]).toBe(
        "renamed Unresolved/unresolved.forge-notify.forge-notify.on-forge-payments-settled (the repo in its id)",
      );
      expect(removed.get(arrowId)?.[0]).toBe(
        "the host is a deploy token nothing sets: asked now (Unresolved/unresolved.forge-payments.c-token)",
      );

      // A second upgrade has nothing to do.
      expect((await upgradeCheck(root, B30)).pending.map((p) => p.id)).not.toContain(STEP);

      // An undo of the upgrade puts the old ids back: `atticus catalog undo` the catalog (ADR 0195
      // point 7), and the upgrade's backup holds every input the step carried as it was.
      const [backup] = await readdir(join(root, ".atticus", "backups"));
      const kept = await files(join(root, ".atticus", "backups", backup!));
      for (const f of ["dec-suppress-fees.yaml", "dec-suppress-risk.yaml"])
        expect(kept.get(`catalog/curated/curateddecision/${f}`), f).toBe(
          curatedBefore.get(`curateddecision/${f}`),
        );
      expect(kept.get("openspec/changes/rates-from-ledger/change.yaml")).toBe(changeBefore);
      const u = quiet();
      expect(await main(["catalog", "undo", "--yes", "--root", root], u.io), u.err.join("\n")).toBe(
        0,
      );
      expect(await generated(root)).toEqual(before);
    },
    T,
  );
});
