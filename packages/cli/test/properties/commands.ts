import { mkdir, rename, rm, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import {
  HOSTS_STEP,
  listQuestions,
  parseRecord,
  recordPath,
  serializeRecord,
} from "@maycombhq/core";
import { main } from "../../src/main.js";
import {
  commitCode,
  renderFacts,
  resolve,
  sketchArb,
  writeManifest,
  type Code,
  type Sketch,
} from "./estate.js";
import { checkStep, type Invariant, type Step } from "./invariants.js";
import type { Model } from "./model.js";
import { SYSTEM, type Outcome } from "./system.js";
import { records, sameTree, type Snap, type World } from "./world.js";

/**
 * The commands of ADR 0195 point 10, as plain data (so a shrunk counterexample can be committed
 * as JSON and replayed) and one fast-check command that runs any of them against the world,
 * updates the model by the ADR's rules, and checks the invariants asked for. Repos are named by
 * slot, so a command still means the same repo after a rename.
 */
export type Desc =
  | { t: "scan" }
  | { t: "scan-subset"; slots: number[] }
  | { t: "scan-not-cloned"; slot: number }
  | { t: "scan-reader-fails"; slot: number }
  /** A commit in the repo: its code as a sketch (generated) or as written (the examples). */
  | { t: "change-code"; slot: number; sketch?: Sketch; code?: Code }
  | { t: "verify-write"; slot: number; ok: boolean }
  | { t: "verify-live"; slot: number }
  | { t: "answer"; host: number; to: number | "none" }
  | { t: "curate"; action: "suppress" | "assert"; pick: number }
  | { t: "uncurate"; pick: number }
  | { t: "archive"; slot: number }
  | { t: "remove"; slot: number }
  | { t: "hand-edit"; pick: number; how: "change" | "delete" }
  | { t: "discard-edits" }
  | { t: "confirm-removals" }
  | { t: "rename"; slot: number }
  | { t: "undo" }
  | { t: "upgrade"; yes: boolean }
  | { t: "again" };

/** What fast-check's model is here: the model, the world, and the invariants to check. */
export interface Ctx {
  m: Model;
  w: World;
  enabled: ReadonlySet<Invariant>;
}

/** What one command did; undefined when it didn't apply (nothing to do), so nothing is checked. */
interface Acted {
  outcome?: Outcome;
  observed?: number[];
  unobserved?: number[];
  afterUndo?: Snap;
  lastWrite?: { before: Snap; after: Snap };
}

const ENV_CHANGES = new Set<Desc["t"]>([
  "change-code",
  "verify-live",
  "answer",
  "curate",
  "uncurate",
  "archive",
  "remove",
  "hand-edit",
  "rename",
  "undo",
  "upgrade",
  "discard-edits",
  "confirm-removals",
]);

export class Cmd implements fc.AsyncCommand<Ctx, World> {
  ran = false;
  constructor(readonly desc: Desc) {}

  check(): boolean {
    return true;
  }

  async run(ctx: Ctx, w: World): Promise<void> {
    this.ran = true;
    const editsBefore = [...ctx.m.handEdits];
    const before = await w.snap();
    const acted = await act(this.desc, ctx.m, w, before);
    if (!acted) return;
    const after = await w.snap();
    // An upgrade or a rename that left the catalog and the slots as they were wrote nothing (an
    // upgrade of a metarepo that has slots does nothing): it isn't a build to check.
    if (
      acted.outcome?.wrote &&
      (this.desc.t === "upgrade" || this.desc.t === "rename") &&
      sameTree(before.generated, after.generated) &&
      sameTree(before.sources, after.sources)
    )
      acted.outcome = { ...acted.outcome, wrote: false };
    if (acted.outcome?.wrote) ctx.m.writes++;
    const step: Step = { desc: this.desc, m: ctx.m, w, before, after, editsBefore, ...acted };
    checkStep(step, ctx.enabled);
    if (acted.outcome?.wrote) {
      ctx.m.wrote();
      if (!sameTree(before.generated, after.generated) || !sameTree(before.sources, after.sources))
        w.lastWrite = { before, after };
    }
    if (ENV_CHANGES.has(this.desc.t)) w.lastWriter = undefined;
  }

  toString(): string {
    return JSON.stringify(this.desc);
  }
}

const live = (m: Model, slot: number) => {
  const r = m.repos[slot % m.repos.length]!;
  return r.listed && !r.archived ? r : undefined;
};

/** Run a scan the way the person asked, with the clone moved away for "not cloned". */
async function scan(m: Model, w: World, d: Desc): Promise<Acted | undefined> {
  const n = m.repos.length;
  const asked =
    d.t === "scan-subset"
      ? [...new Set(d.slots.map((s) => s % n))].filter((s) => live(m, s))
      : m.live().map((r) => r.slot);
  if (d.t === "scan-subset" && !asked.length) return undefined;
  const target =
    d.t === "scan-not-cloned" || d.t === "scan-reader-fails" ? live(m, d.slot) : undefined;
  if ((d.t === "scan-not-cloned" || d.t === "scan-reader-fails") && !target) return undefined;
  const once = async () => {
    const aside = join(w.top, "aside");
    if (d.t === "scan-not-cloned") await rename(w.clone(target!.id), aside);
    try {
      return await SYSTEM.scan(w.root, {
        ...(d.t === "scan-subset" ? { repos: asked.map((s) => m.repos[s]!.id) } : {}),
        ...(d.t === "scan-reader-fails" ? { failOn: target!.id } : {}),
      });
    } finally {
      if (d.t === "scan-not-cloned") await rename(aside, w.clone(target!.id));
    }
  };
  const outcome = await once();
  w.lastWriter = once;
  // The ADR's rule: each repo the scan read in full is observed; the others keep their last read.
  // A scan a guard refused writes no slot, so it observed nothing.
  const observed = outcome.guard ? [] : asked.filter((s) => s !== target?.slot);
  for (const s of observed) {
    const r = m.repos[s]!;
    const was = m.readers.get(s);
    if (!was || was.commit !== r.commit || was.id !== r.id) m.changes.slots.add(s);
    m.readers.set(s, { code: r.code, commit: r.commit, id: r.id });
  }
  const unobserved = m
    .live()
    .map((r) => r.slot)
    .filter((s) => !observed.includes(s));
  return { outcome, observed, unobserved };
}

async function act(d: Desc, m: Model, w: World, before: Snap): Promise<Acted | undefined> {
  const n = m.repos.length;
  switch (d.t) {
    case "scan":
    case "scan-subset":
    case "scan-not-cloned":
    case "scan-reader-fails":
      return scan(m, w, d);

    case "change-code": {
      const r = m.repos[d.slot % n]!;
      if (!r.listed) return undefined;
      const bases = m.repos.map((x) => x.base);
      r.code = d.code ?? resolve(bases, r.slot, d.sketch!);
      m.history.get(r.slot)!.push(r.code);
      r.commit = await commitCode(w.clone(r.id), r.base, r.code, r.commits++);
      return {};
    }

    case "verify-write":
    case "verify-live": {
      const r = live(m, d.slot);
      if (!r) return undefined;
      const ok = d.t === "verify-live" || d.ok;
      await mkdir(join(w.root, "facts"), { recursive: true });
      await writeFile(
        join(w.root, "facts", `${r.id}.jsonl`),
        renderFacts(r.base, r.id, r.code, r.commit, { broken: !ok }),
      );
      const write = d.t === "verify-write";
      const once = () => SYSTEM.verify(w.root, r.id, { write });
      const outcome = await once();
      if (write && ok && outcome.code !== 0 && !outcome.guard)
        throw new Error(`harness: verify --write of good facts failed: ${outcome.err.join("\n")}`);
      if (write) {
        w.lastWriter = once;
        if (ok && !outcome.guard) {
          const was = m.facts.get(r.slot);
          if (!was || was.commit !== r.commit || was.id !== r.id) m.changes.slots.add(r.slot);
          m.facts.set(r.slot, { code: r.code, commit: r.commit, id: r.id });
        }
      }
      return { outcome };
    }

    case "answer": {
      const h = live(m, d.host);
      const to = d.to === "none" ? undefined : live(m, d.to);
      if (!h || (d.to !== "none" && (!to || to.slot === h.slot))) return undefined;
      const host = h.base.legacyHost;
      const q = (await listQuestions(w.root, { step: HOSTS_STEP, state: "open" })).questions.find(
        (x) => x.question.includes(host),
      );
      const i = q?.options.findIndex((o) => o.label === (to ? to.id : "None of these")) ?? -1;
      if (!q || i < 0) return undefined;
      const said: string[] = [];
      const io = { out: (l: string) => said.push(l), err: (l: string) => said.push(l) };
      const code = await main(
        [
          "questions",
          "answer",
          q.id,
          "--option",
          String(i + 1),
          "--by",
          "forge.dev",
          "--root",
          w.root,
        ],
        io,
      );
      if (code !== 0) throw new Error(`harness: questions answer failed: ${said.join("\n")}`);
      if (to) to.hosts.push(host);
      m.answers.set(host, to ? to.slot : "none");
      m.changes.answered.add(host);
      return { outcome: await SYSTEM.build(w.root) };
    }

    case "curate": {
      const endpoints = [...records(before.generated).values()]
        .filter((r) => r.kind === "Endpoint" && r.endpointType === "rest")
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      if (!endpoints.length) return undefined;
      const e = endpoints[d.pick % endpoints.length]!;
      const r = m.slotOfComponent(String(e.component));
      const id = `cd-${d.action}-${e.id}`;
      if (!r || m.curated.some((x) => x.id === id)) return undefined;
      const p = parseRecord({
        kind: "CuratedDecision",
        id,
        schemaVersion: 2,
        status: "current",
        confidence: "asserted",
        target: e.id,
        action: d.action,
        value: d.action === "assert" ? { auth: "oauth2" } : null,
        reason: "A person's decision in the property tests.",
        by: "forge.dev",
        at: "2026-11-11T09:00:00Z",
      });
      if (!p.ok) throw new Error(`harness: bad curated decision ${JSON.stringify(p.issues)}`);
      const file = join(w.root, "catalog", "curated", ...recordPath(p.record).split("/"));
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, serializeRecord(p.record));
      m.curated.push({
        id,
        action: d.action,
        target: e.id,
        slot: r.slot,
        method: String(e.method),
        path: String(e.pathOrTopic),
        since: m.writes,
      });
      m.changes.curated.add(e.id);
      return { outcome: await SYSTEM.build(w.root) };
    }

    case "uncurate": {
      if (!m.curated.length) return undefined;
      const [dec] = m.curated.splice(d.pick % m.curated.length, 1);
      const file = [...before.curated.keys()].find((k) => k.endsWith(`${dec!.id}.yaml`));
      if (file) await rm(join(w.root, "catalog", "curated", ...file.split("/")));
      m.changes.curated.add(dec!.target);
      return { outcome: await SYSTEM.build(w.root) };
    }

    case "archive":
    case "remove": {
      const r = live(m, d.slot);
      if (!r) return undefined;
      if (d.t === "archive") r.archived = true;
      else r.listed = false;
      await writeManifest(w.root, m.manifest());
      m.changes.slots.add(r.slot);
      return { outcome: await SYSTEM.build(w.root) };
    }

    case "hand-edit": {
      const files = [...before.generated.keys()].sort();
      if (!files.length) return undefined;
      const rel = files[d.pick % files.length]!;
      const full = join(w.root, "catalog", "generated", ...rel.split("/"));
      if (d.how === "change") await appendFile(full, "# edited by hand\n");
      else await rm(full);
      if (!m.handEdits.includes(rel)) m.handEdits.push(rel);
      return {};
    }

    case "discard-edits": {
      if (!m.handEdits.length) return undefined;
      const outcome = await SYSTEM.discardEdits(w.root, m.handEdits.length);
      if (outcome.wrote) m.handEdits = [];
      return { outcome };
    }

    case "confirm-removals":
      return { outcome: await SYSTEM.confirmRemovals(w.root) };

    case "rename": {
      const r = live(m, d.slot);
      if (!r || r.id.endsWith("-core")) return undefined;
      const to = `${r.id}-core`;
      const outcome = await SYSTEM.rename(w.root, r.id, to);
      if (outcome.code === 0) {
        // The person clones it again under its new id (atticus workspace sync, here a move).
        if (existsSync(w.clone(r.id))) await rename(w.clone(r.id), w.clone(to));
        r.id = to;
        m.changes.slots.add(r.slot);
      }
      return { outcome };
    }

    case "undo": {
      // Undo refuses over hand edits, as a build does: there is nothing to check then.
      const last = w.lastWrite;
      if (!last || m.handEdits.length) return undefined;
      const outcome = await SYSTEM.undo(w.root);
      const afterUndo = await w.snap();
      await SYSTEM.undo(w.root);
      return { outcome, afterUndo, lastWrite: last };
    }

    case "upgrade": {
      const outcome = await SYSTEM.upgrade(w.root, { yes: d.yes });
      if (d.yes && outcome.code === 0) m.upgraded = true;
      return { outcome };
    }

    case "again": {
      if (!w.lastWriter) return undefined;
      const outcome = (await w.lastWriter(w)) as Outcome;
      return { outcome };
    }
  }
}

/**
 * The commands, weighted toward the writers. A repo is a slot number taken modulo the estate's
 * size, so the commands are made apart from the estate and each shrinks on its own.
 */
export function commandArbs(): fc.Arbitrary<Cmd>[] {
  const slot = fc.nat({ max: 4 });
  const n = 5;
  const d = (a: fc.Arbitrary<Desc>) => a.map((x) => new Cmd(x));
  const scanAll = d(fc.constant({ t: "scan" }));
  const change = d(fc.record({ t: fc.constant("change-code" as const), slot, sketch: sketchArb }));
  const verifyWrite = d(
    fc.record({ t: fc.constant("verify-write" as const), slot, ok: fc.boolean() }),
  );
  const curate = d(
    fc.record({
      t: fc.constant("curate" as const),
      action: fc.constantFrom("suppress" as const, "assert" as const),
      pick: fc.nat(30),
    }),
  );
  const live = d(fc.record({ t: fc.constant("verify-live" as const), slot }));
  const again = d(fc.constant({ t: "again" }));
  // fast-check picks among these evenly: a command listed twice or more comes up that much more.
  return [
    ...[scanAll, scanAll, scanAll, scanAll],
    d(
      fc.record({
        t: fc.constant("scan-subset" as const),
        slots: fc.uniqueArray(slot, { minLength: 1, maxLength: n }),
      }),
    ),
    d(fc.record({ t: fc.constant("scan-not-cloned" as const), slot })),
    d(fc.record({ t: fc.constant("scan-reader-fails" as const), slot })),
    ...[change, change, change],
    ...[verifyWrite, verifyWrite, verifyWrite],
    ...[live, live],
    d(
      fc.record({
        t: fc.constant("answer" as const),
        host: slot,
        to: fc.oneof(slot, fc.constant("none" as const)),
      }),
    ),
    ...[curate, curate],
    d(fc.record({ t: fc.constant("uncurate" as const), pick: fc.nat(30) })),
    d(fc.record({ t: fc.constant("archive" as const), slot })),
    d(fc.record({ t: fc.constant("remove" as const), slot })),
    d(
      fc.record({
        t: fc.constant("hand-edit" as const),
        pick: fc.nat(60),
        how: fc.constantFrom("change" as const, "delete" as const),
      }),
    ),
    d(fc.constant({ t: "discard-edits" })),
    d(fc.constant({ t: "confirm-removals" })),
    d(fc.record({ t: fc.constant("rename" as const), slot })),
    d(fc.constant({ t: "undo" })),
    d(fc.record({ t: fc.constant("upgrade" as const), yes: fc.boolean() })),
    ...[again, again],
  ];
}
