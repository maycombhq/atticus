import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { askedGapQuestionId, readQuestion, sha256Of } from "@maycombhq/core";
import { readBuildReport, undoDirOf } from "@maycombhq/scanner";
import { main } from "../src/main.js";
import { upgradeCheck, upgradeCommand } from "../src/upgrade.js";
import { unresolvedIdsApply, unresolvedIdsPending } from "../src/upgrade-unresolved-ids.js";

/**
 * ADR 0124 addendum E-ids (the owner, 2026-11-19): an Unresolved record's id carries its repo,
 * `unresolved.<repo>.<fact id>`, and one upgrade step names the loose ends of a metarepo an
 * earlier Atticus built again, with every input that cites one carried to its new id. And ADR
 * 0195's beta.28.1 addendum, its sub-addendum of the same day: a call to `${NAME}` that nothing
 * sets is asked about, as `@name@` is, so the arrow beta.28.5 drew by its path goes.
 *
 * fixtures/upgrade-b30/unresolved-ids/metarepo is a metarepo as 2.0.0-beta.28.5 built and wrote
 * it (its README says what it holds). The review of 93ddfc5e: the step lists exactly the files it
 * writes, so each is in the upgrade's backup; an old id goes to the one repo the old catalog cited
 * (beta.28.5's merge cited the first repo, by id), never to every repo; the result is the same
 * whether a beta.30 build ran first or not; and an undo says what it leaves.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../../../fixtures/upgrade-b30/unresolved-ids/metarepo");
const B30 = "2.0.0-beta.30";
const T = 300_000;
const STEP = "unresolved-ids-repo";
const CHANGE = "rates-from-ledger";
const CHANGE_DIR = `openspec/changes/${CHANGE}`;
const FINDING = `${CHANGE_DIR}/review/design/1/gap-rates-target.yaml`;
const GAP_Q = "questions/q-b47c626d92cc.yaml";
const SURVEY_Q = "questions/q-420f3cf447b4.yaml";
const SPEC = "specs/forge-ledger/forge-ledger.read-the-rates.yaml";
const DISMISSALS = "facts/forge-ledger.crosscheck.yaml";
const DEC = (id: string) => `catalog/curated/curateddecision/${id}.yaml`;

/** Each old id, and the id the step gives it. */
const CARRIED: Record<string, string> = {
  "unresolved.c-1": "unresolved.forge-ledger.c-1",
  "unresolved.c-solo": "unresolved.forge-ledger.c-solo",
  "unresolved.c-risk": "unresolved.forge-ledger.c-risk",
  // Suppressed, so in no record on disk: beta.28.5's merge cited the first repo by id.
  "unresolved.c-7": "unresolved.forge-notify.c-7",
  "unresolved.forge-notify.on-forge-payments-settled":
    "unresolved.forge-notify.forge-notify.on-forge-payments-settled",
  "unresolved.forge-payments.on-forge-ledger-refunded":
    "unresolved.forge-payments.forge-payments.on-forge-ledger-refunded",
};
/** A file's text with every old id (as a whole value) given its new one. */
const carried = (text: string) =>
  text.replace(/unresolved\.[a-z0-9.-]+[a-z0-9]/g, (id) => CARRIED[id] ?? id);

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
async function files(dir: string, skip: (rel: string) => boolean = () => false) {
  const out = new Map<string, string>();
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      const rel = relative(dir, p).split(sep).join("/");
      if (skip(rel)) continue;
      if (e.isDirectory()) await walk(p);
      else out.set(rel, await readFile(p, "utf8"));
    }
  };
  await walk(dir);
  return out;
}
/** The metarepo's own files: no local state, no undo copies, no stamp. */
const tree = (root: string) =>
  files(root, (rel) => /^(\.atticus|\.index)(\/|$)/.test(rel) || rel === ".gitignore");
const generated = (root: string) => files(join(root, "catalog", "generated"));
const unresolvedIds = (m: Map<string, string>) =>
  [...m.keys()]
    .filter((p) => p.startsWith("unresolved/"))
    .map((p) => p.slice("unresolved/".length).replace(/\.yaml$/, ""))
    .sort();
const yamlOf = async (root: string, rel: string) =>
  parse(await readFile(join(root, ...rel.split("/")), "utf8")) as Record<string, unknown>;
/** The arrow beta.28.5 drew by its path for the call to ${FORGE_LEDGER_URL}. */
const tokenArrow = (m: Map<string, string>) =>
  [...m].filter(([p, t]) => p.startsWith("interface/") && t.includes("joined-by-path"));

/** The input files the step carries ids in (the files it writes, but the gap question's new one). */
const INPUTS = [
  DEC("dec-suppress-fees"),
  DEC("dec-suppress-listen"),
  DEC("dec-suppress-risk"),
  DISMISSALS,
  `${CHANGE_DIR}/change.yaml`,
  FINDING,
  GAP_Q,
  SURVEY_Q,
  SPEC,
];

/**
 * The old record of `unresolved.c-1` as if the catalog's last build had cited forge-payments'
 * line (forge-ledger's call came after it), its hash in build.json made to match, so it is no hand
 * edit: the repo the old catalog cited is then not the first by id.
 */
async function citePayments(root: string): Promise<void> {
  const rel = "catalog/generated/unresolved/unresolved.c-1.yaml";
  const path = join(root, ...rel.split("/"));
  const text = (await readFile(path, "utf8"))
    .replace("repo: forge-ledger", "repo: forge-payments")
    .replace("owner: forge-ledger", "owner: forge-payments")
    .replace("/v1/rates/forge-ledger", "/v1/rates/forge-payments");
  await writeFile(path, text);
  const manifest = join(root, "catalog", "sources", "build.json");
  const m = JSON.parse(await readFile(manifest, "utf8")) as {
    files: { path: string; sha256: string }[];
  };
  m.files.find((f) => f.path === rel)!.sha256 = sha256Of(text);
  await writeFile(manifest, JSON.stringify(m, null, 2) + "\n");
}
/** The undo copies taken away (a machine that pruned them), the latest build's report kept. */
async function dropUndoCopies(root: string): Promise<void> {
  const dir = await undoDirOf(root);
  for (const n of await readdir(dir).catch(() => [] as string[]))
    if (/^\d+$/.test(n)) await rm(join(dir, n), { recursive: true, force: true });
}
/** A curated decision as Atticus writes it (canonical, schema version 5). */
const decision = (id: string, target: string, reason: string) =>
  [
    "schemaVersion: 5",
    "kind: CuratedDecision",
    `id: ${id}`,
    "status: current",
    "confidence: asserted",
    "action: suppress",
    "at: 2026-11-20T00:00:00Z",
    "by: sam",
    "evidence: []",
    `reason: ${reason}`,
    `target: ${target}`,
    "value: null",
    "",
  ].join("\n");

describe("atticus upgrade names every loose end again with its repo (ADR 0124 addendum E-ids)", () => {
  it("is the only step a metarepo beta.28.5 built and wrote has, and lists every file it writes", async () => {
    const root = await metarepo();
    const c = await upgradeCheck(root, B30);
    expect(c.pending.map((p) => p.id)).toEqual([STEP]);
    const newGap = `questions/${askedGapQuestionId(CHANGE, {
      rule: "constitution.touched-components-known",
      artifact: "catalog",
      locator: { record: "unresolved.forge-ledger.c-1" },
      summary: "Where the rates call goes is unknown.",
    })}.yaml`;
    expect(c.pending[0]!.files).toEqual(
      [
        ...INPUTS,
        newGap,
        "catalog/generated/unresolved/unresolved.c-1.yaml",
        "catalog/generated/unresolved/unresolved.c-solo.yaml",
        "catalog/generated/unresolved/unresolved.forge-notify.on-forge-payments-settled.yaml",
        "catalog/sources/build.json",
      ].sort(),
    );
  });

  it("refuses to write a file it didn't list", async () => {
    const root = await metarepo();
    const listed = await unresolvedIdsPending(root);
    const before = await tree(root);
    await expect(
      unresolvedIdsApply(root, { listed: listed.filter((f) => f !== DEC("dec-suppress-listen")) }),
    ).rejects.toThrow(/dec-suppress-listen\.yaml.*wasn't listed/);
    expect(await tree(root)).toEqual(before);
  });

  it(
    "renames them as moves, carries every id that cites one, asks nothing, and says what an undo leaves",
    async () => {
      const root = await metarepo();
      const before = await tree(root);
      const genBefore = await generated(root);
      expect(unresolvedIds(genBefore)).toEqual([
        "unresolved.c-1",
        "unresolved.c-solo",
        "unresolved.forge-notify.on-forge-payments-settled",
      ]);
      const [[arrowPath]] = tokenArrow(genBefore) as [[string, string]];

      const q = quiet();
      expect(await upgradeCommand(root, { by: "pat" }, q.io, B30), q.err.join("\n")).toBe(0);
      // The guard asked nothing: no count to confirm, nothing refused.
      expect([...q.out, ...q.err].join("\n")).not.toMatch(/--allow-removals|refus/i);
      const after = await tree(root);
      const gen = await generated(root);

      // Each loose end under its repo's id. forge-payments' c-1 and c-7, which had no record,
      // have their own now: c-7 is a loose end nobody took off the map (the decision was of the
      // record beta.28.5 showed, forge-notify's). The ${FORGE_LEDGER_URL} call is asked.
      expect(unresolvedIds(gen)).toEqual([
        "unresolved.forge-ledger.c-1",
        "unresolved.forge-ledger.c-solo",
        "unresolved.forge-notify.forge-notify.on-forge-payments-settled",
        "unresolved.forge-payments.c-1",
        "unresolved.forge-payments.c-7",
        "unresolved.forge-payments.c-token",
      ]);
      expect(tokenArrow(gen)).toEqual([]);
      expect(gen.get("unresolved/unresolved.forge-ledger.c-1.yaml")).toBe(
        carried(genBefore.get("unresolved/unresolved.c-1.yaml")!),
      );

      // Every input file is byte for byte as it was but for its carried ids; the gap's owner
      // question is re-keyed to the id the carried finding gives it, so its answer still closes it.
      const finding = await yamlOf(root, FINDING);
      expect((finding.locator as { record: string }).record).toBe("unresolved.forge-ledger.c-1");
      const newId = askedGapQuestionId(CHANGE, finding as never);
      const newGap = `questions/${newId}.yaml`;
      for (const f of INPUTS.filter((x) => x !== GAP_Q))
        expect(after.get(f), f).toBe(carried(before.get(f)!));
      expect(after.has(GAP_Q)).toBe(false);
      expect(after.get(newGap)).toBe(before.get(GAP_Q)!.replaceAll("q-b47c626d92cc", newId));
      expect((await readQuestion(root, newId))?.state).toBe("open");
      const untouched = (m: Map<string, string>) =>
        [...m].filter(
          ([p]) =>
            !p.startsWith("catalog/generated/") &&
            p !== "catalog/sources/build.json" &&
            !INPUTS.includes(p) &&
            p !== newGap,
        );
      expect(untouched(after)).toEqual(untouched(before));
      // Every other record is byte for byte as it was, but the feature that listed the arrow.
      const arrowId = arrowPath.slice("interface/".length, -".yaml".length);
      const named = [...genBefore].filter(([, t]) => t.includes(arrowId)).map(([p]) => p);
      const others = (m: Map<string, string>) =>
        [...m].filter(([p]) => !p.startsWith("unresolved/") && !named.includes(p));
      expect(others(gen)).toEqual(others(genBefore));

      // The renames listed as moves (counted toward no limit), the arrow's removal with why.
      const report = await readBuildReport(root);
      expect(report?.outcome).toBe("written");
      const removed = new Map((report?.removed ?? []).map((x) => [x.id, x.explainedBy]));
      expect(removed.get("unresolved.c-1")?.[0]).toBe(
        "renamed Unresolved/unresolved.forge-ledger.c-1 (the repo in its id)",
      );
      expect(removed.get(arrowId)?.[0]).toBe(
        "the host is a deploy token nothing sets: asked now (Unresolved/unresolved.forge-payments.c-token)",
      );

      // The upgrade's backup holds every file the step wrote, as it was.
      const [backup] = await readdir(join(root, ".atticus", "backups"));
      const kept = await files(join(root, ".atticus", "backups", backup!));
      for (const f of INPUTS) expect(kept.get(f), f).toBe(before.get(f));

      // A second upgrade has nothing to do.
      expect((await upgradeCheck(root, B30)).pending).toEqual([]);

      // An undo takes the catalog back, and says what it leaves: the inputs name the new ids.
      const u = quiet();
      expect(await main(["catalog", "undo", "--yes", "--root", root], u.io), u.err.join("\n")).toBe(
        0,
      );
      expect(await generated(root)).toEqual(genBefore);
      const said = u.out.join("\n");
      expect(said).not.toMatch(/took back the upgrade; run atticus upgrade --yes/);
      expect(said).toContain(
        `the inputs it carried still name the loose ends' new ids: ${[...INPUTS.filter((x) => x !== GAP_Q), newGap].sort().join(", ")}`,
      );
      expect(said).toContain(`.atticus/backups/${backup}/`);
    },
    T,
  );

  it(
    "gives the same result when a beta.30 build ran before the upgrade",
    async () => {
      const direct = await metarepo();
      expect(await upgradeCommand(direct, { by: "pat" }, quiet().io, B30)).toBe(0);
      const root = await metarepo();
      const b = quiet();
      expect(await main(["catalog", "build", "--root", root], b.io), b.err.join("\n")).toBe(0);
      // Until the upgrade, a decision of an old id says to run it, never that its target returns.
      const said = b.out.join("\n");
      expect(said).toContain(
        "The curated decision dec-suppress-fees targets unresolved.c-7, a loose end's id from before beta.30 (no repo in it): run atticus upgrade, which carries it to its repo's id.",
      );
      expect(said).not.toMatch(/dec-suppress-fees targets a record that isn't in the build/);
      expect(await upgradeCommand(root, { by: "pat" }, quiet().io, B30)).toBe(0);
      expect(await generated(root)).toEqual(await generated(direct));
      const ins = (m: Map<string, string>) => [...m].filter(([p]) => !p.startsWith("catalog/"));
      expect(ins(await tree(root))).toEqual(ins(await tree(direct)));
      expect(await files(join(root, "catalog", "curated"))).toEqual(
        await files(join(direct, "catalog", "curated")),
      );
    },
    T,
  );

  it(
    "carries an old id to the repo the old record cited, not the first by id, in either order",
    async () => {
      // Direct: the record on disk says forge-payments.
      const direct = await metarepo();
      await citePayments(direct);
      expect(await upgradeCommand(direct, { by: "pat" }, quiet().io, B30)).toBe(0);
      const finding = await yamlOf(direct, FINDING);
      expect((finding.locator as { record: string }).record).toBe("unresolved.forge-payments.c-1");
      const touches = (
        (await yamlOf(direct, `${CHANGE_DIR}/change.yaml`)).touches as {
          records: string[];
        }
      ).records;
      expect(touches).toContain("unresolved.forge-payments.c-1");
      expect(touches).not.toContain("unresolved.forge-ledger.c-1");
      // forge-ledger's call has a loose end of its own: nobody's input names it.
      expect(unresolvedIds(await generated(direct))).toContain("unresolved.forge-ledger.c-1");
      const ins = (m: Map<string, string>) => [...m].filter(([p]) => !p.startsWith("catalog/"));

      // A beta.30 build first: the step reads the old record from that build's undo copy; and
      // with the undo copies gone, from that build's report (its renamed lines).
      for (const drop of [false, true]) {
        const root = await metarepo();
        await citePayments(root);
        const b = quiet();
        expect(await main(["catalog", "build", "--root", root], b.io), b.err.join("\n")).toBe(0);
        if (drop) await dropUndoCopies(root);
        expect(await upgradeCommand(root, { by: "pat" }, quiet().io, B30)).toBe(0);
        expect(ins(await tree(root)), `undo copies dropped: ${drop}`).toEqual(
          ins(await tree(direct)),
        );
        expect(await generated(root), `undo copies dropped: ${drop}`).toEqual(
          await generated(direct),
        );
      }
    },
    T,
  );

  it(
    "never carries an id onto one a person's decision already names, nor a file over another",
    async () => {
      // A decision made on beta.30 of forge-notify's c-7, the id the old suppress goes to.
      const root = await metarepo();
      await writeFile(
        join(root, ...DEC("dec-keep-notify-c7").split("/")),
        decision("dec-keep-notify-c7", "unresolved.forge-notify.c-7", "notify's call is known"),
      );
      const before = await tree(root);
      const q = quiet();
      expect(await upgradeCommand(root, { by: "pat" }, q.io, B30)).toBe(1);
      const said = q.err.join("\n");
      expect(said).toMatch(
        /dec-suppress-fees targets unresolved\.c-7, which goes to unresolved\.forge-notify\.c-7, but dec-keep-notify-c7 targets unresolved\.forge-notify\.c-7 already/,
      );
      expect(said).toMatch(/Nothing of this step was written/);
      expect(await tree(root)).toEqual(before);

      // A curated loose end whose new id's file is there already.
      const other = await metarepo();
      const gen = await readFile(
        join(other, "catalog", "generated", "unresolved", "unresolved.c-solo.yaml"),
        "utf8",
      );
      const curated = join(other, "catalog", "curated", "unresolved");
      await rm(curated, { recursive: true, force: true });
      await cp(join(other, "catalog", "generated", "unresolved"), curated, { recursive: true });
      for (const f of await readdir(curated))
        if (f !== "unresolved.c-solo.yaml") await rm(join(curated, f));
      await writeFile(
        join(curated, "unresolved.forge-ledger.c-solo.yaml"),
        gen.replace("id: unresolved.c-solo", "id: unresolved.forge-ledger.c-solo"),
      );
      const before2 = await tree(other);
      const q2 = quiet();
      expect(await upgradeCommand(other, { by: "pat" }, q2.io, B30)).toBe(1);
      expect(q2.err.join("\n")).toMatch(
        /catalog\/curated\/unresolved\/unresolved\.forge-ledger\.c-solo\.yaml is there already/,
      );
      expect(await tree(other)).toEqual(before2);

      // The same after a beta.30 build: no loose end of the old form on disk, still refused.
      const b = quiet();
      expect(await main(["catalog", "build", "--root", other], b.io), b.err.join("\n")).toBe(0);
      const before3 = await tree(other);
      const q3 = quiet();
      expect(await upgradeCommand(other, { by: "pat" }, q3.io, B30)).toBe(1);
      expect(q3.err.join("\n")).toMatch(/unresolved\.forge-ledger\.c-solo\.yaml is there already/);
      expect(await tree(other)).toEqual(before3);
    },
    T,
  );
});
