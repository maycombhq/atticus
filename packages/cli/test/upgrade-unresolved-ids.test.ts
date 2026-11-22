import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { askedGapQuestionId, readQuestion, sha256Of } from "@maycombhq/core";
import {
  buildAndWrite,
  readBuildReport,
  refusalCommands,
  refusedBeforeSlots,
} from "@maycombhq/scanner";
import { refusalView } from "../src/build-report.js";
import { refusalHint } from "../src/catalog-build-commands.js";
import { main } from "../src/main.js";
import { statusCommand } from "../src/standing.js";
import { upgradeCheck, upgradeCommand, type UpgradeStepRefusal } from "../src/upgrade.js";
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
/** A call of fact id c-1 in forge-notify too, after the last build (its facts read again). */
async function addNotifyC1(root: string): Promise<void> {
  const dir = join(root, "catalog", "sources", "facts");
  const pay = (await readFile(join(dir, "forge-payments.jsonl"), "utf8"))
    .split("\n")
    .find((l) => l.includes('"id":"c-1"'))!;
  const line = pay.replaceAll("forge-payments", "forge-notify").replace('"line":4', '"line":40');
  const file = join(dir, "forge-notify.jsonl");
  const text = (await readFile(file, "utf8")).replace(/\n?$/, "\n") + line + "\n";
  await writeFile(file, text);
  const meta = join(dir, "forge-notify.meta.json");
  const m = JSON.parse(await readFile(meta, "utf8")) as { factsHash: string };
  m.factsHash = sha256Of(text);
  await writeFile(meta, JSON.stringify(m, null, 2) + "\n");
}
/**
 * The metarepo as a teammate's fresh clone of it has it: its committed files only (no .index, so
 * no undo copy and no build report; of .atticus, only the stamp `atticus upgrade` commits).
 */
async function clone(root: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "b30-ids-clone-"));
  roots.push(dir);
  const to = join(dir, "forge");
  await cp(root, to, {
    recursive: true,
    filter: (src) => {
      const rel = relative(root, src).split(sep).join("/");
      if (rel === ".index" || rel.startsWith(".index/")) return false;
      return !rel.startsWith(".atticus/") || rel === ".atticus/metarepo.yaml";
    },
  });
  return to;
}
/** forge-payments' call of fact id c-1 gone from its facts (read again since). */
async function dropPaymentsC1(root: string): Promise<void> {
  const dir = join(root, "catalog", "sources", "facts");
  const file = join(dir, "forge-payments.jsonl");
  const text = (await readFile(file, "utf8"))
    .split("\n")
    .filter((l) => !l.includes('"id":"c-1"'))
    .join("\n");
  await writeFile(file, text);
  const meta = join(dir, "forge-payments.meta.json");
  const m = JSON.parse(await readFile(meta, "utf8")) as { factsHash: string };
  m.factsHash = sha256Of(text);
  await writeFile(meta, JSON.stringify(m, null, 2) + "\n");
}
/**
 * A checkout of a repo under workspace/ with the lines its facts file cites (a copy, as a sync
 * leaves one where git isn't used), so `atticus verify <repo>` checks them as a clone would.
 */
async function checkoutFromFacts(root: string, repo: string): Promise<void> {
  const files = new Map<string, string[]>();
  for (const l of (await readFile(join(root, "facts", `${repo}.jsonl`), "utf8")).split("\n")) {
    if (!l.trim()) continue;
    const f = JSON.parse(l) as {
      cite?: { file: string; line: number; quote?: string; value: string };
    };
    if (!f.cite) continue;
    const lines = files.get(f.cite.file) ?? [];
    while (lines.length < f.cite.line) lines.push("");
    lines[f.cite.line - 1] = f.cite.quote ?? f.cite.value;
    files.set(f.cite.file, lines);
  }
  for (const [file, lines] of files) {
    const to = join(root, "workspace", repo, ...file.split("/"));
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, lines.join("\n") + "\n");
  }
}
/** What a command said, out and err, with the metarepo's folder as <root>. */
const saidBy = (q: { out: string[]; err: string[] }, root: string) =>
  [...q.out, ...q.err].join("\n").replaceAll(root, "<root>");
/** The refusal's words (ADR 0124 addendum E-ids, 2026-11-22). */
const RENAMES = (n: number) =>
  `Run atticus upgrade: it renames ${n} loose end${n === 1 ? "" : "s"} your changes name and carries your changes in one write.`;
/** One of your changes (a suppress) as Atticus writes it (canonical, schema version 5). */
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
/** One of your changes that sets fields of a record (an assert), as Atticus writes it. */
const assertion = (id: string, target: string, kind: string) =>
  [
    "schemaVersion: 5",
    "kind: CuratedDecision",
    `id: ${id}`,
    "status: current",
    "confidence: asserted",
    "action: assert",
    "at: 2026-11-20T00:00:00Z",
    "by: sam",
    "evidence: []",
    "reason: the rates call is known",
    `target: ${target}`,
    "value:",
    `  unresolvedKind: ${kind}`,
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

      // The owner, 2026-11-21 (ADR 0195's addendum of that day): an undo of the step takes back
      // the catalog and the inputs it carried, so every file is as it was before the upgrade.
      const u = quiet();
      expect(await main(["catalog", "undo", "--yes", "--root", root], u.io), u.err.join("\n")).toBe(
        0,
      );
      expect(await tree(root)).toEqual(before);
      const said = u.out.join("\n");
      expect(said).not.toMatch(/took back the upgrade; run atticus upgrade --yes/);
      expect(said).not.toMatch(/still name the loose ends' new ids/);
      expect(said).toContain(
        `It put back your changes and the other files the step carried to the new ids, as they were before it: ${[...INPUTS, newGap].sort().join(", ")}.`,
      );
      // The step is pending again, and the undo can itself be undone.
      expect((await upgradeCheck(root, B30)).pending.map((p) => p.id)).toEqual([STEP]);
      const uu = quiet();
      expect(
        await main(["catalog", "undo", "--yes", "--root", root], uu.io),
        uu.err.join("\n"),
      ).toBe(0);
      expect(await tree(root)).toEqual(after);
      // Back again, and the upgrade run a second time gives what the first gave.
      expect(await main(["catalog", "undo", "--yes", "--root", root], quiet().io)).toBe(0);
      expect(await tree(root)).toEqual(before);
      expect(await upgradeCommand(root, { by: "pat" }, quiet().io, B30)).toBe(0);
      expect(await tree(root)).toEqual(after);
    },
    T,
  );

  it(
    "refuses a build that would rename a loose end your changes name, the same on a fresh clone, and the upgrade then gives the direct result",
    async () => {
      const direct = await metarepo();
      expect(await upgradeCommand(direct, { by: "pat" }, quiet().io, B30)).toBe(0);
      const root = await metarepo();
      const before = await tree(root);
      const genBefore = await generated(root);
      // The owner, 2026-11-22: a beta.30 build that would name an old loose end again with its
      // repo while one of your changes names its old id refuses, writing nothing, so the old
      // record stays in catalog/generated for the upgrade to decide by.
      const b = quiet();
      expect(await main(["catalog", "build", "--root", root], b.io)).toBe(1);
      const said = saidBy(b, root);
      expect(said).toContain(RENAMES(6));
      expect(said).not.toMatch(/still names|this build applies it/);
      expect(await tree(root)).toEqual(before);
      expect(await generated(root)).toEqual(genBefore);
      // The step says so, and so does a clone of it, in the same words.
      expect((await upgradeCheck(root, B30)).pending.map((p) => p.id)).toEqual([STEP]);
      const fresh = await clone(root);
      const c = quiet();
      expect(await main(["catalog", "build", "--root", fresh], c.io)).toBe(1);
      expect(saidBy(c, fresh)).toBe(said);
      // A second build refuses the same; the upgrade on either gives the direct one's files.
      const b2 = quiet();
      expect(await main(["catalog", "build", "--root", root], b2.io)).toBe(1);
      expect(saidBy(b2, root)).toBe(said);
      for (const r of [root, fresh]) {
        expect(await upgradeCommand(r, { by: "pat" }, quiet().io, B30)).toBe(0);
        expect(await tree(r)).toEqual(await tree(direct));
      }
      // build(build(x)) is build(x), on the clone too.
      for (const r of [root, fresh]) {
        const once = await tree(r);
        const a1 = quiet();
        expect(await main(["catalog", "build", "--root", r], a1.io), a1.err.join("\n")).toBe(0);
        expect(await tree(r)).toEqual(once);
        expect(await main(["catalog", "build", "--root", r], quiet().io)).toBe(0);
        expect(await tree(r)).toEqual(once);
      }
    },
    T,
  );

  it(
    "says the way on from that refusal as the step does it: --dry-run shows, atticus upgrade does it",
    async () => {
      // The final review of b30/unresolved-ids (I1): plain `atticus upgrade` applies an ordinary
      // step (backed up, undoable); `--yes` gates only the slots adoption; the preview is
      // --dry-run. The refusal's flags tell it from a catalog from before the slots (the nit).
      const root = await metarepo();
      const command = "atticus catalog build";
      const r = await buildAndWrite(root, { command });
      const refused = r.guard.refused!;
      expect(refused.reasons).toEqual(["not-upgraded"]);
      expect(refused.renames).toBe(6);
      expect(refused.beforeSlots).toBeUndefined();
      expect(refusedBeforeSlots(refused)).toBe(false);
      expect(refusalCommands(refused, command)).toEqual([
        "atticus upgrade --dry-run",
        "atticus upgrade",
      ]);
      expect(refusalHint(refused, command)).toBe(
        `${RENAMES(6)} atticus upgrade --dry-run shows what it would write; atticus upgrade does it.`,
      );
      // The app's view of it (API 3.19.0, additive): the count, the first command.
      const view = refusalView(root, refused, command);
      expect(view).toMatchObject({ renames: 6, command: "atticus upgrade --dry-run" });
      expect(view).not.toHaveProperty("beforeSlots");
      // The command line, its --json, the report and atticus status: never --yes for it.
      const b = quiet();
      expect(await main(["catalog", "build", "--root", root], b.io)).toBe(1);
      expect(saidBy(b, root)).not.toContain("--yes");
      const j = quiet();
      expect(await main(["catalog", "build", "--json", "--root", root], j.io)).toBe(1);
      expect(
        (JSON.parse(j.out.join("\n")) as { refused: Record<string, unknown> }).refused,
      ).toMatchObject({ reasons: ["not-upgraded"], renames: 6 });
      expect((await readBuildReport(root))?.run).toEqual([
        "atticus upgrade --dry-run",
        "atticus upgrade",
      ]);
      const s = quiet();
      expect(await statusCommand(root, {}, s.io, { version: B30 })).toBe(1);
      expect(s.out[0]).toMatch(/Do: atticus upgrade$/);
      // The preview writes nothing and names the step; atticus upgrade then does it.
      const before = await tree(root);
      const d = quiet();
      expect(
        await upgradeCommand(root, { by: "pat", dryRun: true }, d.io, B30),
        d.err.join("\n"),
      ).toBe(0);
      expect(await tree(root)).toEqual(before);
      expect(d.out.join("\n")).toMatch(
        /^1 upgrade step to run \(atticus upgrade\):\n  Loose ends named with their repo, .*: 14 files$/,
      );
      const u = quiet();
      expect(await upgradeCommand(root, { by: "pat" }, u.io, B30), u.err.join("\n")).toBe(0);
      expect((await upgradeCheck(root, B30)).pending).toEqual([]);
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

      // A beta.30 build first refuses (one of your changes names unresolved.c-1), so the old
      // record is still in catalog/generated for the step: on this machine and on a fresh clone.
      for (const fromClone of [false, true]) {
        const first = await metarepo();
        await citePayments(first);
        const b = quiet();
        expect(await main(["catalog", "build", "--root", first], b.io)).toBe(1);
        expect(saidBy(b, first)).toContain(RENAMES(6));
        const root = fromClone ? await clone(first) : first;
        expect(await upgradeCommand(root, { by: "pat" }, quiet().io, B30)).toBe(0);
        expect(ins(await tree(root)), `a fresh clone: ${fromClone}`).toEqual(
          ins(await tree(direct)),
        );
        expect(await generated(root), `a fresh clone: ${fromClone}`).toEqual(
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
        /^Your change dec-suppress-fees targets unresolved\.c-7, which goes to unresolved\.forge-notify\.c-7, but your change dec-keep-notify-c7 targets unresolved\.forge-notify\.c-7 already/m,
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

      // A beta.30 build waits for the upgrade (your curated loose end names an old id), and
      // the upgrade still refuses.
      const b = quiet();
      expect(await main(["catalog", "build", "--root", other], b.io)).toBe(1);
      expect(saidBy(b, other)).toContain("Run atticus upgrade: it renames");
      expect(await tree(other)).toEqual(before2);
      const before3 = await tree(other);
      const q3 = quiet();
      expect(await upgradeCommand(other, { by: "pat" }, q3.io, B30)).toBe(1);
      expect(q3.err.join("\n")).toMatch(/unresolved\.forge-ledger\.c-solo\.yaml is there already/);
      expect(await tree(other)).toEqual(before3);
    },
    T,
  );

  it(
    "tells the app the count and plan that confirm a step's removals, and confirms exactly those",
    async () => {
      // forge-notify's read taken away since: the step's build removes its records, more than
      // the limits let a build remove unasked, so it waits for them to be confirmed.
      const root = await metarepo();
      for (const f of ["forge-notify.jsonl", "forge-notify.meta.json"])
        await rm(join(root, "catalog", "sources", "facts", f));
      const before = await tree(root);
      let refused: UpgradeStepRefusal | undefined;
      const q = quiet();
      expect(
        await upgradeCommand(root, { by: "pat", onRefused: (r) => (refused = r) }, q.io, B30),
      ).toBe(1);
      expect(await tree(root)).toEqual(before);
      const r = refused as UpgradeStepRefusal | undefined;
      expect(r?.step).toBe(STEP);
      const n = r?.confirm?.allowRemovals ?? 0;
      expect(n).toBeGreaterThan(0);
      expect(r?.confirm?.plan).toMatch(/^[0-9a-f]{64}$/);
      expect(q.err.join("\n")).toContain(`atticus upgrade --allow-removals ${n}`);
      // Another list's plan writes nothing.
      const w = quiet();
      expect(
        await upgradeCommand(
          root,
          { by: "pat", allowRemovals: n, plan: "0".repeat(64) },
          w.io,
          B30,
        ),
      ).toBe(1);
      expect(w.err.join("\n")).toMatch(/isn't what the page listed any more/);
      expect(await tree(root)).toEqual(before);
      // The count and plan given: upgraded.
      const ok = quiet();
      expect(
        await upgradeCommand(
          root,
          { by: "pat", allowRemovals: n, plan: r!.confirm!.plan },
          ok.io,
          B30,
        ),
        ok.err.join("\n"),
      ).toBe(0);
      expect((await upgradeCheck(root, B30)).pending).toEqual([]);
    },
    T,
  );

  it(
    "refuses an undo of the step over an input changed since, changing nothing",
    async () => {
      const root = await metarepo();
      expect(await upgradeCommand(root, { by: "pat" }, quiet().io, B30)).toBe(0);
      const change = join(root, ...`${CHANGE_DIR}/change.yaml`.split("/"));
      await writeFile(change, (await readFile(change, "utf8")) + "# a person's note\n");
      const before = await tree(root);
      const u = quiet();
      expect(await main(["catalog", "undo", "--yes", "--root", root], u.io)).toBe(1);
      const said = u.err.join("\n");
      expect(said).toMatch(/^Nothing undone: 1 file was changed since/);
      expect(said).toContain(`${CHANGE_DIR}/change.yaml`);
      expect(await tree(root)).toEqual(before);
    },
    T,
  );

  it(
    "stays pending, saying why, when a refused carry is the only one, and the build waits for it",
    async () => {
      const root = await metarepo();
      // No input names an old id but a curated loose end, whose new id's file is there already.
      for (const rel of [
        "catalog/curated/curateddecision",
        DISMISSALS,
        CHANGE_DIR,
        GAP_Q,
        SURVEY_Q,
        SPEC,
      ])
        await rm(join(root, ...rel.split("/")), { recursive: true, force: true });
      const curated = join(root, "catalog", "curated", "unresolved");
      const gen = await readFile(
        join(root, "catalog", "generated", "unresolved", "unresolved.c-solo.yaml"),
        "utf8",
      );
      await cp(join(root, "catalog", "generated", "unresolved"), curated, { recursive: true });
      for (const f of await readdir(curated))
        if (f !== "unresolved.c-solo.yaml") await rm(join(curated, f));
      await writeFile(
        join(curated, "unresolved.forge-ledger.c-solo.yaml"),
        gen.replace("id: unresolved.c-solo", "id: unresolved.forge-ledger.c-solo"),
      );
      const b = quiet();
      expect(await main(["catalog", "build", "--root", root], b.io)).toBe(1);
      expect(saidBy(b, root)).toContain(RENAMES(1));
      const c = await upgradeCheck(root, B30);
      expect(c.pending.map((p) => [p.id, p.files])).toEqual([
        [
          STEP,
          [
            "catalog/curated/unresolved/unresolved.c-solo.yaml",
            "catalog/generated/unresolved/unresolved.c-1.yaml",
            "catalog/generated/unresolved/unresolved.c-solo.yaml",
            "catalog/generated/unresolved/unresolved.forge-notify.on-forge-payments-settled.yaml",
            "catalog/sources/build.json",
          ],
        ],
      ]);
      const before = await tree(root);
      const q = quiet();
      expect(await upgradeCommand(root, { by: "pat" }, q.io, B30)).toBe(1);
      expect(q.err.join("\n")).toMatch(
        /catalog\/curated\/unresolved\/unresolved\.forge-ledger\.c-solo\.yaml is there already, so your change catalog\/curated\/unresolved\/unresolved\.c-solo\.yaml can't move to it/,
      );
      expect(await tree(root)).toEqual(before);
    },
    T,
  );

  it(
    "brings a metarepo from before source slots up to date in one upgrade, and carries once its repos are read from facts",
    async () => {
      // As beta.26 left a metarepo: catalog/generated, no catalog/sources/.
      const root = await metarepo();
      const facts = await files(join(root, "catalog", "sources", "facts"));
      await rm(join(root, "catalog", "sources"), { recursive: true, force: true });
      const before = await tree(root);
      const ins = (m: Map<string, string>) => [...m].filter(([p]) => !p.startsWith("catalog/"));
      const curatedOf = (m: Map<string, string>) =>
        [...m].filter(([p]) => p.startsWith("catalog/curated/"));

      // The dry run lists the adoption, and says what follows it and what it can't know yet.
      const d = quiet();
      expect(await upgradeCommand(root, { by: "pat", dryRun: true }, d.io, B30)).toBe(0);
      expect(d.out.join("\n")).toContain(
        "3 loose ends have an id from before beta.30 (unresolved.<fact id>), and 3 of your changes name one. The upgrade keeps them, as it keeps every record it moves into stored reads. Once a repo's facts are applied (atticus verify <repo> --write), a build that would name a loose end your changes name with its repo waits for atticus upgrade, which renames it and carries your changes in one write. Which repo each id goes to can't be known before then.",
      );

      // One upgrade: the adoption, and nothing left pending. The loose ends keep their ids (a
      // legacy repo's records as they were adopted), and every input is as it was.
      const q = quiet();
      expect(
        await upgradeCommand(root, { by: "pat", yes: true }, q.io, B30),
        q.err.join("\n"),
      ).toBe(0);
      expect((await upgradeCheck(root, B30)).pending).toEqual([]);
      expect(unresolvedIds(await generated(root))).toEqual([
        "unresolved.c-1",
        "unresolved.c-solo",
        "unresolved.forge-notify.on-forge-payments-settled",
      ]);
      const adopted = await tree(root);
      expect(ins(adopted)).toEqual(ins(before));
      expect(curatedOf(adopted)).toEqual(curatedOf(before));
      // A decision of a suppressed loose end waits for the read, and says so (not "run atticus
      // upgrade", which has nothing to carry yet).
      const b = quiet();
      expect(await main(["catalog", "build", "--root", root], b.io), b.err.join("\n")).toBe(0);
      const said = b.out.join("\n");
      expect(said).toContain(
        "Your change dec-suppress-fees targets unresolved.c-7, a loose end's id from before beta.30 (no repo in it), and this build has no loose end of that id under its repo's: it is kept, and applies again once the loose end is back. A repo whose read is still the one the upgrade kept gets its repo's id in its loose ends when its facts are applied (atticus verify <repo> --write): that build waits for atticus upgrade, which renames them and carries your changes in one write.",
      );
      expect(said).not.toMatch(
        /dec-suppress-fees targets unresolved\.c-7, .*: run atticus upgrade/,
      );

      // The repos read from facts (the facts slots verify --write leaves, for the legacy ones):
      // the build would name the loose ends your changes name with their repo, so it refuses
      // and writes nothing, on this machine and on a fresh clone alike.
      for (const [rel, text] of facts) {
        const to = join(root, "catalog", "sources", "facts", ...rel.split("/"));
        await cp(join(FIXTURE, "catalog", "sources", "facts", ...rel.split("/")), to);
        expect(await readFile(to, "utf8")).toBe(text);
      }
      for (const f of await readdir(join(root, "catalog", "sources", "readers")))
        await rm(join(root, "catalog", "sources", "readers", f));
      const read = await tree(root);
      const r = quiet();
      expect(await main(["catalog", "build", "--root", root], r.io)).toBe(1);
      expect(saidBy(r, root)).toContain(RENAMES(6));
      expect(await tree(root)).toEqual(read);
      const fresh = await clone(root);
      const rc = quiet();
      expect(await main(["catalog", "build", "--root", fresh], rc.io)).toBe(1);
      expect(saidBy(rc, fresh)).toBe(saidBy(r, root));
      // The upgrade renames them and carries what names them, in one write, by the old records
      // still in catalog/generated (c-7, with none: the first repo by id, as beta.28.5's merge
      // cited it): what a direct upgrade gives, on either.
      const direct = await metarepo();
      expect(await upgradeCommand(direct, { by: "pat" }, quiet().io, B30)).toBe(0);
      for (const x of [root, fresh]) {
        expect((await upgradeCheck(x, B30)).pending.map((p) => p.id)).toEqual([STEP]);
        expect(await upgradeCommand(x, { by: "pat" }, quiet().io, B30)).toBe(0);
        expect((await upgradeCheck(x, B30)).pending).toEqual([]);
        const now = await tree(x);
        const want = await tree(direct);
        expect(unresolvedIds(await generated(x))).toEqual(unresolvedIds(await generated(direct)));
        expect(ins(now)).toEqual(ins(want));
        expect(curatedOf(now)).toEqual(curatedOf(want));
        // And a build after it changes nothing.
        const g = await generated(x);
        const a1 = quiet();
        expect(await main(["catalog", "build", "--root", x], a1.io), a1.err.join("\n")).toBe(0);
        expect(await generated(x)).toEqual(g);
      }
      expect(await tree(fresh)).toEqual(await tree(root));
    },
    T,
  );
  it(
    "a metarepo from before slots: a real verify --write that would rename waits, and the upgrade applies that read and carries, the same on a fresh clone",
    async () => {
      const root = await metarepo();
      await rm(join(root, "catalog", "sources"), { recursive: true, force: true });
      expect(await upgradeCommand(root, { by: "pat", yes: true }, quiet().io, B30)).toBe(0);
      expect((await upgradeCheck(root, B30)).pending).toEqual([]);
      await checkoutFromFacts(root, "forge-notify");
      // atticus verify forge-notify --write: its facts verify, and the build would name the
      // loose ends two of your changes name with forge-notify's id, so it waits, the catalog
      // unchanged.
      const catalogBefore = await files(join(root, "catalog"));
      const v = quiet();
      expect(await main(["verify", "forge-notify", "--write", "--root", root], v.io)).toBe(1);
      expect(saidBy(v, root)).toContain(RENAMES(2));
      expect(await files(join(root, "catalog"))).toEqual(catalogBefore);
      // The step has work: the read verify checked, as forge-notify's facts slot, and the carry.
      const fresh = await clone(root);
      await cp(join(root, "workspace"), join(fresh, "workspace"), { recursive: true });
      const c = await upgradeCheck(root, B30);
      expect(c.pending.map((p) => p.id)).toEqual([STEP]);
      expect(c.pending[0]!.files).toEqual(
        expect.arrayContaining([
          "catalog/sources/facts/forge-notify.jsonl",
          "catalog/sources/facts/forge-notify.meta.json",
          DEC("dec-suppress-fees"),
        ]),
      );
      // A checkout whose lines no longer hold what the facts cite: the read doesn't verify, so
      // the step refuses in verify's words and writes nothing.
      const broken = await clone(root);
      await cp(join(root, "workspace"), join(broken, "workspace"), { recursive: true });
      await writeFile(
        join(
          broken,
          "workspace",
          "forge-notify",
          "src",
          "main",
          "java",
          "forge",
          "client",
          "Client.java",
        ),
        "// moved\n",
      );
      const brokenBefore = await tree(broken);
      const bq = quiet();
      expect(await unresolvedIdsPending(broken)).toEqual(
        expect.arrayContaining(["catalog/sources/facts/forge-notify.jsonl"]),
      );
      expect(await upgradeCommand(broken, { by: "pat" }, bq.io, B30)).toBe(1);
      expect(bq.err.join("\n")).toMatch(
        /^forge-notify's facts \(facts\/forge-notify\.jsonl\) don't verify as atticus verify forge-notify --write checks them: \d+ facts? (was|were) rejected\. Nothing of this step was written: run atticus verify forge-notify to see why/m,
      );
      expect(await tree(broken)).toEqual(brokenBefore);
      for (const r of [root, fresh]) {
        const u = quiet();
        expect(await upgradeCommand(r, { by: "pat" }, u.io, B30), u.err.join("\n")).toBe(0);
        expect((await yamlOf(r, DEC("dec-suppress-fees"))).target).toBe(
          "unresolved.forge-notify.c-7",
        );
        expect(unresolvedIds(await generated(r))).not.toContain("unresolved.forge-notify.c-7");
        expect(await readFile(join(r, "catalog/sources/facts/forge-notify.jsonl"), "utf8")).toBe(
          await readFile(join(r, "facts/forge-notify.jsonl"), "utf8"),
        );
      }
      // The same read, carried the same, byte for byte on either.
      expect(await tree(fresh)).toEqual(await tree(root));
      // The next verify --write goes through, and nothing waits.
      for (const r of [root, fresh]) {
        const again = quiet();
        expect(
          await main(["verify", "forge-notify", "--write", "--root", r], again.io),
          [...again.out, ...again.err].join("\n"),
        ).toBe(0);
        expect((await upgradeCheck(r, B30)).pending).toEqual([]);
      }
      // As alike again, but for when verify raised its questions (a clock it reads).
      const unclocked = async (r: string) =>
        new Map(
          [...(await tree(r))].map(([k, t]) => [
            k,
            k.startsWith("questions/") ? t.replace(/^ {2}at: .*$/gm, "  at: <time>") : t,
          ]),
        );
      expect(await unclocked(fresh)).toEqual(await unclocked(root));
    },
    T,
  );
});

/**
 * The final review of 5cc4ce87 (B1, B2): once a beta.30 build had renamed a loose end, the old
 * record naming which repo it cited was gone from the committed files, so the build, its guard
 * and the step decided by this machine's undo copies: a teammate's clone took a different loose
 * end off the map, and its upgrade wrote that choice into your change for good. The owner,
 * 2026-11-22: such a build refuses on every machine, and the upgrade decides by the old record
 * still committed in catalog/generated.
 */
describe("the same commit refuses and upgrades the same on every machine (ADR 0124 addendum E-ids, 2026-11-22)", () => {
  /** The old record of unresolved.c-1 cites forge-payments; one of your changes names it. */
  const setUp = async (change: string) => {
    const root = await metarepo();
    await citePayments(root);
    await writeFile(join(root, ...DEC("dec-c1").split("/")), change);
    return root;
  };
  const suppressC1 = decision("dec-c1", "unresolved.c-1", "the rates call is known");
  const assertC1 = assertion("dec-c1", "unresolved.c-1", "http-call-known");

  /** A scenario on this machine and on a fresh clone: both refuse alike, then upgrade alike. */
  async function bothWays(root: string, between: (r: string) => Promise<void>) {
    // This machine: a build (refused), then the change between, then a build again.
    const b1 = quiet();
    expect(await main(["catalog", "build", "--root", root], b1.io)).toBe(1);
    await between(root);
    const before = await tree(root);
    const b2 = quiet();
    expect(await main(["catalog", "build", "--root", root], b2.io)).toBe(1);
    expect(await tree(root)).toEqual(before);
    // A teammate's clone of the same commit: refused in the same words, nothing written.
    const fresh = await clone(root);
    const c = quiet();
    expect(await main(["catalog", "build", "--root", fresh], c.io)).toBe(1);
    expect(saidBy(c, fresh)).toBe(saidBy(b2, root));
    expect(saidBy(c, fresh)).toContain("Run atticus upgrade: it renames");
    expect(await tree(fresh)).toEqual(before);
    // The upgrade on each gives byte for byte the same catalog and inputs.
    for (const r of [root, fresh])
      expect(await upgradeCommand(r, { by: "pat" }, quiet().io, B30), r).toBe(0);
    const after = await tree(root);
    expect(await tree(fresh)).toEqual(after);
    // build(build(x)) is build(x) on the clone.
    for (const n of [1, 2]) {
      const a = quiet();
      expect(
        await main(["catalog", "build", "--root", fresh], a.io),
        `${n}: ${a.err.join("\n")}`,
      ).toBe(0);
      expect(await tree(fresh)).toEqual(after);
    }
    return { after, fresh };
  }

  it(
    "B1: a third repo's call of the fact id since: both refuse, then carry to the cited repo",
    async () => {
      const root = await setUp(suppressC1);
      const { fresh } = await bothWays(root, addNotifyC1);
      expect((await yamlOf(fresh, DEC("dec-c1"))).target).toBe("unresolved.forge-payments.c-1");
      const ids = unresolvedIds(await generated(fresh));
      // forge-ledger's and forge-notify's loose ends show (nobody took them off the map).
      expect(ids).toContain("unresolved.forge-ledger.c-1");
      expect(ids).toContain("unresolved.forge-notify.c-1");
      expect(ids).not.toContain("unresolved.forge-payments.c-1");
    },
    T,
  );

  it(
    "B2: the cited repo's call gone since: both refuse, and carry to the id the cited repo gives",
    async () => {
      const root = await setUp(suppressC1);
      const { fresh } = await bothWays(root, dropPaymentsC1);
      // Carried to forge-payments' id, which no loose end has now: kept, applies when it is back.
      expect((await yamlOf(fresh, DEC("dec-c1"))).target).toBe("unresolved.forge-payments.c-1");
      // forge-ledger's loose end is not the one taken off the map: it shows.
      expect(unresolvedIds(await generated(fresh))).toContain("unresolved.forge-ledger.c-1");
      const a = quiet();
      expect(await main(["catalog", "build", "--root", fresh], a.io)).toBe(0);
      expect(a.out.join("\n")).toContain(
        "Your change dec-c1 targets a record that isn't in the build; it is kept and applies again when its target returns.",
      );
    },
    T,
  );

  it(
    "an assert of an old id: both refuse, then carry it to the cited repo's loose end, the same on each",
    async () => {
      const root = await setUp(assertC1);
      const { fresh } = await bothWays(root, addNotifyC1);
      expect((await yamlOf(fresh, DEC("dec-c1"))).target).toBe("unresolved.forge-payments.c-1");
      const rec = await yamlOf(
        fresh,
        "catalog/generated/unresolved/unresolved.forge-payments.c-1.yaml",
      );
      expect(rec.unresolvedKind).toBe("http-call-known");
      for (const other of ["forge-ledger", "forge-notify"])
        expect(
          (await yamlOf(fresh, `catalog/generated/unresolved/unresolved.${other}.c-1.yaml`))
            .unresolvedKind,
        ).toBe("http-call");
    },
    T,
  );

  it(
    "renames, with no refusal, a loose end no input names",
    async () => {
      // Only the cross-check dismissal and the spec name c-solo, and nothing names c-1: take
      // every other input away, then build. The loose ends no input names are renamed as now.
      const root = await metarepo();
      for (const rel of [
        "catalog/curated/curateddecision",
        DISMISSALS,
        CHANGE_DIR,
        GAP_Q,
        SURVEY_Q,
        SPEC,
      ])
        await rm(join(root, ...rel.split("/")), { recursive: true, force: true });
      const b = quiet();
      expect(await main(["catalog", "build", "--root", root], b.io), b.err.join("\n")).toBe(0);
      expect(unresolvedIds(await generated(root))).toContain("unresolved.forge-ledger.c-1");
      expect((await upgradeCheck(root, B30)).pending).toEqual([]);
    },
    T,
  );
});
