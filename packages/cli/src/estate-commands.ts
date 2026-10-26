import {
  listQuestions,
  loadOrgPack,
  orgPackDirOf,
  questionId,
  raiseQuestions,
  readEstateJoins,
  readRepoSpec,
  slugify,
  specRepos,
  specsRelOf,
  templateRef,
  writeEstateJoins,
  type EstateJoins,
  type Question,
  type QuestionDraft,
  type SpecTemplate,
} from "@maycombhq/core";
import {
  estateFlow as followFlow,
  estateStepKey,
  fieldLineage,
  joinEstate,
  type EstateAsk,
  type EstateFlow,
  type EstateSpec,
  type EstateStep,
} from "@maycombhq/scanner";
import { fsRepo } from "@maycombhq/sdk";
import type { Output } from "./commands.js";
import { loadCatalog } from "./diagram-commands.js";
import { askHosts } from "./host-questions.js";
import { repoFor } from "./onboard-commands.js";

/**
 * atticus estate join, flow and lineage (ADR 0085): the estate pass. It joins each repo's
 * call-outs to the flows their targets start (specs/estate.yaml), follows a flow across repos,
 * and follows a field along it to the column it is stored in. Deterministic: no AI.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const HOW: Record<string, string> = {
  interface: "through the Interface",
  endpoint: "to the entry point it names",
  path: "by method and path",
};
const REASON: Record<string, string> = {
  "no-target": "no target",
  "no-flow": "no flow",
  "no-citation": "no citation",
  "family-mismatch": "a wrong family",
};

/**
 * The step that asks which component answers a call-out whose step names a target the catalog
 * doesn't have, when two or more components serve its method and path (ADR 0124 addendum C-join).
 */
export const ESTATE_TARGETS_STEP = "estate-targets";

/** The last option of an estate targets question: none of the components answers it. */
export const ESTATE_TARGETS_NONE = "None of these";

/** The question for a call-out two or more components could answer: one option each. */
export function estateAskDraft(a: EstateAsk): QuestionDraft {
  return {
    question: `Which component answers ${a.what}, which ${a.caller} calls?`,
    options: [
      ...a.candidates.map((c) => ({
        label: c,
        means: `${c} answers ${a.what}`,
        changes: `The call-out joins ${c}'s flow at the next atticus estate join`,
      })),
      {
        label: ESTATE_TARGETS_NONE,
        means: "None of these components answers it",
        changes: "The call-out stays unjoined, and this isn't asked again",
      },
    ],
    evidence: a.from.evidence ? [a.from.evidence] : [],
    scope: "repo",
  };
}

/** The id the question for a call-out has, asked or not. */
export function estateAskId(a: EstateAsk): string {
  const d = estateAskDraft(a);
  return questionId({
    step: ESTATE_TARGETS_STEP,
    repo: a.from.repo,
    question: d.question,
    evidence: d.evidence,
  });
}

/** Every repo's spec in the metarepo; files that don't read go to io.err. */
async function readSpecs(
  root: string,
  io: Output,
  templates?: Record<string, string>,
): Promise<EstateSpec[]> {
  const out: EstateSpec[] = [];
  for (const repo of await specRepos(root)) {
    const s = await readRepoSpec(root, repo, { cacheRoot: root });
    for (const p of s.problems) io.err(`${p.file}: ${p.message}`);
    if (s.flows.length) out.push({ repo, flows: s.flows });
    if (templates && s.header?.template) templates[repo] = s.header.template;
  }
  return out;
}

/** The spec template each repo's spec was drafted against, for spec check's family rule. */
async function specTemplates(
  root: string,
  refs: Record<string, string>,
): Promise<Record<string, SpecTemplate>> {
  const op = await loadOrgPack(orgPackDirOf(root)).catch(() => undefined);
  const out: Record<string, SpecTemplate> = {};
  for (const [repo, ref] of Object.entries(refs)) {
    const t = op?.specTemplates.find((x) => templateRef(x) === ref);
    if (t) out[repo] = t;
  }
  return out;
}

/** atticus estate join [--json]: write specs/estate.yaml. */
export async function estateJoin(
  root: string,
  o: { json?: boolean; now?: Date },
  io: Output,
): Promise<number> {
  const refs: Record<string, string> = {};
  const specs = await readSpecs(root, io, refs);
  if (specs.length === 0) {
    io.err(
      `There are no repo specs in ${specsRelOf(root)}/ yet. Draft them first: atticus spec draft <repo>.`,
    );
    return 2;
  }
  const { records } = await loadCatalog(root, { out: () => {}, err: (l) => io.err(l) });
  const templates = await specTemplates(root, refs);
  // A cited line must exist in the repo's clone; repos without a clone aren't checked.
  const clones = new Map<string, { dir: string; lines: Map<string, number> } | null>();
  const unchecked = new Set<string>();
  const cited = async (repo: string, path: string, line: number) => {
    if (!clones.has(repo)) {
      const r = await repoFor(root, repo);
      clones.set(repo, r ? { dir: r.dir, lines: new Map() } : null);
      if (!r) unchecked.add(repo);
    }
    const c = clones.get(repo);
    if (!c) return true;
    if (!c.lines.has(path)) {
      const t = await fsRepo(repo, c.dir, "0".repeat(40))
        .readText(path)
        .catch(() => undefined);
      c.lines.set(
        path,
        t === undefined ? 0 : t.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").length,
      );
    }
    return line >= 1 && line <= c.lines.get(path)!;
  };
  // A call-out two or more components could answer is asked (the join fallback, ADR 0124
  // addendum C-join); a person's answer names the component, and the join runs again with it.
  const first = await joinEstate({ specs, records, cited, templates });
  const askedBefore = new Map(
    (await listQuestions(root, { step: ESTATE_TARGETS_STEP })).questions.map((q) => [q.id, q]),
  );
  const targets: Record<string, string> = {};
  for (const a of first.asks) {
    const q = askedBefore.get(estateAskId(a));
    if (q?.state !== "answered" || !q.answer) continue;
    const label =
      q.answer.option !== undefined ? q.options[q.answer.option - 1]?.label : q.answer.text;
    if (label && label !== ESTATE_TARGETS_NONE)
      targets[estateStepKey(a.from.flow, a.from.step)] = slugify(label);
  }
  const r = Object.keys(targets).length
    ? await joinEstate({ specs, records, cited, templates, targets })
    : first;
  const at = (o.now ?? new Date()).toISOString();
  const asked: { q: Question; raised: boolean }[] = [];
  for (const a of r.asks) {
    // A question cites its line: a step that cites none stays unjoined, said above.
    if (!a.from.evidence) continue;
    const before = askedBefore.get(estateAskId(a));
    if (before) {
      if (before.state === "open") asked.push({ q: before, raised: false });
      continue;
    }
    const raised = await raiseQuestions(root, [estateAskDraft(a)], {
      step: ESTATE_TARGETS_STEP,
      repo: a.from.repo,
      command: "atticus estate join",
      rerun: "atticus estate join",
      at,
    });
    const q = raised.of[0];
    if (q?.state === "open") asked.push({ q, raised: raised.raised.some((x) => x.id === q.id) });
  }
  const inferred = new Set(r.inferred.map((x) => estateStepKey(x.from.flow, x.from.step)));
  const file: EstateJoins = {
    schemaVersion: 1,
    joinedAt: (o.now ?? new Date()).toISOString(),
    repos: specs.map((s) => s.repo),
    joins: r.joins,
    unmatched: r.unmatched,
  };
  const rel = await writeEstateJoins(root, file);
  // Calls to a host no repo lists join nothing: ask which repo answers on it (ADR 0088).
  const hosts = await askHosts(root, records, {
    command: "atticus estate join",
    ...(o.now ? { now: o.now } : {}),
  });
  if (o.json) {
    io.out(
      JSON.stringify(
        {
          ...file,
          file: rel,
          unchecked: [...unchecked].sort(),
          inferred: r.inferred,
          asks: r.asks,
          questions: [...hosts.raised, ...hosts.open, ...asked.map((x) => x.q)].map((q) => q.id),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const total = r.joins.length + r.unmatched.length;
  io.out(
    `Joined ${r.joins.length} of ${plural(total, "call-out")} across ${plural(specs.length, "repo")} (${file.repos.join(", ")}); written to ${rel}.`,
  );
  for (const j of r.joins)
    io.out(
      `  ${j.from.flow} step ${j.from.step} → ${j.to.flow} (${HOW[j.how]}${j.interface ? ` ${j.interface}` : ""}${inferred.has(estateStepKey(j.from.flow, j.from.step)) ? ", inferred" : ""})`,
    );
  if (r.unmatched.length) {
    io.out(
      `${plural(r.unmatched.length, "call-out")} ${r.unmatched.length === 1 ? "isn't" : "aren't"} joined:`,
    );
    for (const u of r.unmatched)
      io.out(`  ${u.from.flow} step ${u.from.step} (${REASON[u.reason]}): ${u.message}`);
  }
  if (unchecked.size)
    io.out(
      `Cited lines of ${[...unchecked].sort().join(", ")} weren't checked: there is no clone of ${unchecked.size === 1 ? "it" : "them"} here.`,
    );
  if (r.inferred.length)
    io.out(
      `${plural(r.inferred.length, "join is", "joins are")} inferred: ${r.inferred.length === 1 ? "its" : "their"} step names a target that isn't a component in the catalog (a relative call's guessed name, or none), so ${r.inferred.length === 1 ? "it" : "each"} joined the only entry point that serves its method and path, the caller's own repo first. When the repo is next read, a relative call leaves \`to\` out or names the component that serves it.`,
    );
  for (const { q, raised } of asked)
    io.out(
      raised
        ? `Two or more components answer a call-out: asked ${q.id}: ${q.question} Answer it: atticus questions answer ${q.id} --option <n>, then atticus estate join.`
        : `Still open: ${q.question} Answer it: atticus questions answer ${q.id} --option <n>, then atticus estate join.`,
    );
  for (const l of hosts.lines) io.out(l);
  io.out("Next: atticus estate flow <flow-id> follows a flow across repos.");
  return 0;
}

/** The specs and joins, or an error when the estate pass hasn't run or the flow isn't there. */
async function loadJoined(
  root: string,
  flowId: string,
  depth: number | undefined,
  io: Output,
): Promise<EstateFlow | undefined> {
  const joins = await readEstateJoins(root);
  if (!joins) {
    io.err(
      `There is no ${specsRelOf(root)}/estate.yaml yet. Join the repos' flows first: atticus estate join.`,
    );
    return undefined;
  }
  const f = followFlow({
    flow: flowId,
    specs: await readSpecs(root, io),
    joins,
    ...(depth !== undefined ? { depth } : {}),
  });
  if (!f) io.err(`There is no flow ${flowId} in ${specsRelOf(root)}/.`);
  return f;
}

const cite = (s: EstateStep) => {
  const e = s.step.evidence[0];
  return e?.path
    ? `  [${e.repo ?? s.repo}:${e.path}${e.line !== undefined ? `:${e.line}` : ""}]`
    : "";
};
const list = (xs: string[]) => (xs.length ? xs.join(", ") : "nothing named");

function render(f: EstateFlow, indent: string, out: string[]) {
  for (const s of f.steps) {
    out.push(`${indent}${s.n} ${s.step.kind}: ${s.step.what}${cite(s)}`);
    const c = s.call;
    if (!c) continue;
    const pad = `${indent}  `;
    if (c.join) {
      const callee = c.callee?.flow;
      out.push(
        `${pad}→ ${c.join.to.flow}${callee ? `: ${callee.name}` : ""} (${c.join.to.repo}), ${HOW[c.join.how]}${c.join.interface ? ` ${c.join.interface}` : ""}`,
      );
      const x = c.crossing!;
      out.push(
        `${pad}  sends ${list(x.sends)}; the callee takes ${list(x.receives)}; returns ${list(x.returns)}`,
      );
      for (const m of x.objects)
        out.push(`${pad}  ${m.sent} carries the callee's ${m.fields.join(", ")}`);
      if (x.unused.length)
        out.push(`${pad}  sent but not used by the callee: ${x.unused.join(", ")}`);
      if (c.callee) render(c.callee, pad, out);
      else if (c.stopped === "cycle")
        out.push(`${pad}  (not followed: ${c.join.to.flow} is already on the path)`);
      else if (c.stopped === "depth")
        out.push(`${pad}  (not followed: the depth limit; raise --depth)`);
    } else if (c.unmatched)
      out.push(`${pad}✗ not joined (${REASON[c.unmatched.reason]}): ${c.unmatched.message}`);
    else out.push(`${pad}✗ not joined yet: the specs changed since atticus estate join ran`);
  }
}

/** atticus estate flow <flow-id> [--depth n] [--json]: a flow followed across repos. */
export async function estateFlowCommand(
  root: string,
  flowId: string,
  o: { json?: boolean; depth?: number },
  io: Output,
): Promise<number> {
  const f = await loadJoined(root, flowId, o.depth, io);
  if (!f) return 2;
  if (o.json) {
    io.out(JSON.stringify(f, null, 2));
    return 0;
  }
  const t = f.flow.trigger;
  const e = t.evidence[0];
  const out = [
    `${f.flow.id}: ${f.flow.name} (${f.repo})`,
    `Trigger (${t.kind}): ${t.what}${e?.path ? `  [${e.repo ?? f.repo}:${e.path}${e.line !== undefined ? `:${e.line}` : ""}]` : ""}`,
  ];
  render(f, "", out);
  for (const l of out) io.out(l);
  return 0;
}

/** atticus estate lineage <flow-id> <field> [--depth n] [--json]: 0 when it reaches a column, 1 when it breaks. */
export async function estateLineage(
  root: string,
  flowId: string,
  field: string,
  o: { json?: boolean; depth?: number },
  io: Output,
): Promise<number> {
  const f = await loadJoined(root, flowId, o.depth, io);
  if (!f) return 2;
  const l = fieldLineage(f, field);
  if (o.json) {
    io.out(JSON.stringify(l, null, 2));
    return l.stored ? 0 : 1;
  }
  io.out(`${field} along ${flowId}:`);
  for (const k of l.links)
    io.out(
      `  ${k.n} ${k.kind}, ${k.as} ${k.field}: ${k.what}${k.evidence ? `  [${k.evidence}]` : ""}`,
    );
  io.out(
    l.stored
      ? `${field} is stored in ${l.stored.table}.${l.stored.column}.`
      : `The chain breaks: ${l.breaks!.message}`,
  );
  return l.stored ? 0 : 1;
}
