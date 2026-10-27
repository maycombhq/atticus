import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { draftSpec } from "@maycombhq/assistant-kit";
import {
  askedByStep,
  listQuestions,
  loadOrgPack,
  orgPackDirOf,
  questionsRelOf,
  raiseQuestions,
  readRepoSpec,
  reusedLine,
  readSpecFindings,
  serializeRecord,
  specFindingFingerprint,
  specRelOf,
  specTemplateFor,
  templateRef,
  writeFlow,
  writeSpecFindings,
  writeSpecHeader,
  type FlowRecord,
  type QuestionDraft,
  type SpecFinding,
  type SpecHeader,
  type SpecTemplate,
} from "@maycombhq/core";
import { stepJudges } from "@maycombhq/planner";
import { checkSpec, citedFileHashes, staleFlows, type SpecCheckFinding } from "@maycombhq/scanner";
import { fsRepo } from "@maycombhq/sdk";
import type { Output } from "./commands.js";
import { loadCatalog } from "./diagram-commands.js";
import { matchedRepoType, repoFor, type OnboardDeps } from "./onboard-commands.js";

/**
 * atticus spec draft and atticus spec check (ADR 0079): a repo's spec of flows, drafted by the
 * assistant through the AI runtime and checked by the deterministic critic. Files are
 * specs/<repo>/ in the metarepo (.atticus/specs/<repo>/ in a repo adopted in place).
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const quiet: Output = { out: () => {}, err: () => {} };

/** The commit a clone has checked out, when the folder is a Git clone's top (not inside another). */
function headOf(dir: string): Promise<string | undefined> {
  const same = (a: string, b: string) =>
    resolve(a).replace(/\\/g, "/").toLowerCase() === resolve(b).replace(/\\/g, "/").toLowerCase();
  return new Promise((done) =>
    execFile(
      "git",
      ["-C", dir, "rev-parse", "--show-toplevel", "HEAD"],
      { timeout: 10_000 },
      (e, out) => {
        const [top, head] = out.trim().split(/\r?\n/);
        done(!e && top && head && same(top, dir) && /^[0-9a-f]{40}$/.test(head) ? head : undefined);
      },
    ),
  );
}

const noRepo = (target: string) =>
  `${target} isn't a cloned repo of the manifest or a folder; clone it with atticus workspace sync, or give its folder.`;

/** The repo, its handle, the spec template its type carries and the type for the prompt. */
async function context(root: string, target: string, io: Output) {
  const repo = await repoFor(root, target);
  if (!repo) return undefined;
  const op = await loadOrgPack(orgPackDirOf(root));
  const commit = await headOf(repo.dir);
  const handle = fsRepo(repo.id, repo.dir, commit ?? "0".repeat(40));
  const repoType = await matchedRepoType(handle, repo.id, op, io);
  const template: SpecTemplate = specTemplateFor(op.specTemplates, repoType?.type.id);
  return { repo, op, handle, commit, repoType, template };
}

/**
 * atticus spec draft <repo> [--attempts 3] [--resume run] [--force]: the assistant writes one
 * flow (or family) per trigger; each flow is checked before it is written. Without --force,
 * only flows that cite a changed file, and triggers with no flow, are drafted.
 */
export async function specDraft(
  root: string,
  target: string,
  o: { attempts?: number; resume?: string; force?: boolean },
  deps: OnboardDeps,
  io: Output,
): Promise<number> {
  const c = await context(root, target, io);
  if (!c) {
    io.err(noRepo(target));
    return 2;
  }
  const { repo, op, handle, commit, repoType, template } = c;
  const { records } = await loadCatalog(root, { out: () => {}, err: (l) => io.err(l) });
  const before = await readRepoSpec(root, repo.id, { cacheRoot: root });
  for (const p of before.problems) io.err(`${p.file}: ${p.message}`);
  const stale = o.force ? [] : await staleFlows(handle, before.flows, before.header?.files ?? {});
  const staleIds = new Set(stale.map((s) => s.flow));
  for (const s of stale)
    io.out(
      `${s.flow} cites ${s.files.join(", ")}, which changed since it was drafted; it is drafted again.`,
    );
  // The last check's findings go back to the assistant, and their flows are drafted again.
  const last = await readSpecFindings(root, repo.id);
  const critic = (last?.findings ?? []).filter((f) => !f.question).map((f) => f.message);
  const flagged = new Set(
    (last?.findings ?? [])
      .filter((f) => !f.question)
      .map(
        (f) => before.flows.find((x) => f.target.startsWith(`${x.id} `) || f.target === x.id)?.id,
      )
      .filter((x): x is string => !!x),
  );
  if (flagged.size)
    io.out(
      `The last spec check found problems in ${[...flagged].join(", ")}; they are drafted again.`,
    );
  const redo = new Set([...staleIds, ...flagged]);
  const keep = o.force ? [] : before.flows.filter((f) => !redo.has(f.id));
  if (!o.force && !o.resume && before.header && redo.size === 0 && critic.length === 0) {
    if (!(await draftSpecNeeded(handle, repo.id, records, template, keep))) {
      io.out(
        `Every trigger of ${repo.id} has a flow, no cited file changed and the last check found nothing to fix. Re-run with --force to draft the spec again.`,
      );
      return 0;
    }
  }
  const questions = (await listQuestions(root, { repo: repo.id })).questions.filter(
    (q) => askedByStep(q, "spec-draft") || askedByStep(q, "spec-check"),
  );
  const r = await draftSpec(handle, {
    repoId: repo.id,
    runtime: deps.runtime,
    records,
    template,
    orgPack: op,
    ...(repoType ? { repoType } : {}),
    questions,
    keep,
    onFile: before.flows,
    critic,
    maxAttempts: o.attempts ?? 3,
    ...(deps.now ? { now: deps.now } : {}),
    ...(o.resume ? { resume: o.resume } : {}),
  });
  if (r.status === "waiting") {
    io.out(
      `Handed the spec to your assistant (run ${r.runId}). When it is done: atticus handoff done ${r.runId}, then atticus spec draft ${repo.id} --resume ${r.runId}`,
    );
    return 0;
  }
  for (const a of r.attempts.filter((x) => x.problems.length > 0)) {
    io.out(`Attempt ${a.attempt}: ${plural(a.problems.length, "problem")}, handed back:`);
    for (const p of a.problems) io.out(`  - ${p}`);
  }
  const at = (deps.now ?? new Date()).toISOString();
  const rel = specRelOf(root, repo.id);
  for (const f of r.flows) await writeFlow(root, repo.id, f);
  // A stale flow the assistant didn't write again stays, marked stale.
  const fresh = new Set(r.flows.map((f) => f.id));
  const left: FlowRecord[] = [];
  for (const f of before.flows.filter((x) => redo.has(x.id) && !fresh.has(x.id))) {
    if (!staleIds.has(f.id)) {
      left.push(f);
      continue;
    }
    const marked = { ...f, flags: [...new Set([...(f.flags ?? []), "stale"])] };
    await writeFlow(root, repo.id, marked);
    left.push(marked);
  }
  // A flow drafted again replaces the one kept.
  const byId = new Map([...keep, ...left].map((f) => [f.id, f]));
  for (const f of r.flows) byId.set(f.id, f);
  const all = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const hashes = {
    ...(before.header?.files ?? {}),
    ...(await citedFileHashes(handle, [...keep.filter((f) => !fresh.has(f.id)), ...r.flows])),
  };
  const rerun = `atticus spec draft ${repo.id}`;
  // ADR 0117: matched by the step's own reading (sameAs) and, where a model can be called, a judge.
  const judges = stepJudges(root, deps.runtime, repo.id, new Date(at));
  const { raised, known, reused } = await raiseQuestions(
    root,
    r.questions,
    {
      step: "spec-draft",
      repo: repo.id,
      command: rerun,
      rerun,
      ...(r.runId ? { run: r.runId } : {}),
      at,
    },
    judges,
  );
  const open = [...raised, ...known.filter((q) => q.state === "open")].map((q) => q.id);
  const header: SpecHeader = {
    schemaVersion: 1,
    repo: repo.id,
    ...(commit ? { commit } : {}),
    template: templateRef(template),
    // The default template ships with Atticus; a repo type's is reviewed in its PR, and a
    // person sets this once it has merged.
    templateReviewed:
      template.repoType === "default" ||
      (before.header?.template === templateRef(template) && before.header.templateReviewed),
    drafted: { at, ...(r.runId ? { run: r.runId } : {}) },
    flows: all.map((f) => f.id),
    files: hashes,
    questions: [...new Set([...(before.header?.questions ?? []), ...open])].sort(),
  };
  if (r.flows.length || !before.header) await writeSpecHeader(root, header);
  else await writeSpecHeader(root, { ...header, drafted: before.header.drafted ?? header.drafted });

  if (r.flows.length)
    io.out(
      `Wrote ${plural(r.flows.length, "flow")} in ${rel}/ (template ${header.template}${header.templateReviewed ? "" : ", not yet reviewed"}):`,
    );
  for (const f of r.flows) {
    const checked = f.steps.filter((s) => s.confirmedBy === "check").length;
    io.out(
      `  ${f.id}: ${f.name} (${plural(f.steps.length, "step")}, ${checked} confirmed by the check${f.family.length ? `, stands for ${f.family.length} more` : ""})`,
    );
  }
  for (const f of r.failed)
    io.out(`  not written: ${f.flow}, still failing: ${f.problems.join("; ")}`);
  for (const t of r.uncovered) io.out(`  no flow yet: ${t.kind} ${t.label} (${t.id})`);
  if (raised.length) {
    io.out(`${plural(raised.length, "question")} for a person, in ${questionsRelOf(root)}/:`);
    for (const q of raised) io.out(`  ${q.id} ${q.question}`);
  }
  for (const q of reused) io.out(reusedLine(q));
  if (r.status === "failed") {
    io.out(
      `No flow passed its checks in ${plural(r.attempts.length, "attempt")}; nothing new was written.`,
    );
    return 1;
  }
  io.out(`Next: atticus spec check ${repo.id}, then review ${rel}/ in a pull request.`);
  return 0;
}

/** Whether any trigger the template finds in the catalog has no flow yet. */
async function draftSpecNeeded(
  handle: ReturnType<typeof fsRepo>,
  repoId: string,
  records: Awaited<ReturnType<typeof loadCatalog>>["records"],
  template: SpecTemplate,
  flows: FlowRecord[],
): Promise<boolean> {
  const r = await checkSpec({ repo: handle, repoId, flows, records, template });
  return r.triggers.some((t) => !t.flow);
}

/** A question from a finding that came back unchanged after a redraft (plan principle 4). */
function findingQuestion(f: SpecCheckFinding, evidence: string): QuestionDraft {
  return {
    question: `The spec check found this again after the flows were drafted again: ${f.message}. What should the flow say?`,
    options: [],
    evidence: [evidence],
    scope: "repo",
  };
}

/**
 * atticus spec check <repo> [--json]: the deterministic critic. Sets confirmedBy: check on the
 * steps whose cited lines name what they claim, writes specs/<repo>/findings.yaml, and turns a
 * finding that came back unchanged after a redraft into a question.
 */
export async function specCheck(
  root: string,
  target: string,
  o: { json?: boolean; now?: Date },
  io: Output,
): Promise<number> {
  const c = await context(root, target, o.json ? quiet : io);
  if (!c) {
    io.err(noRepo(target));
    return 2;
  }
  const { repo, handle, template } = c;
  const spec = await readRepoSpec(root, repo.id, { cacheRoot: root });
  if (!spec.header && spec.flows.length === 0) {
    io.err(`${repo.id} has no spec yet. Draft it: atticus spec draft ${repo.id}`);
    return 2;
  }
  const { records } = await loadCatalog(root, { out: () => {}, err: (l) => io.err(l) });
  // Questions on file about the repo: an entry point a question cites has its caller asked.
  const onFile = (await listQuestions(root, { repo: repo.id })).questions.filter(
    (q) => q.state !== "retired",
  );
  const r = await checkSpec({
    repo: handle,
    repoId: repo.id,
    flows: spec.flows,
    records,
    template,
    questions: onFile,
  });
  const findings: SpecCheckFinding[] = [...r.findings];
  for (const p of spec.problems)
    findings.push({
      rule: "line-missing",
      target: p.file,
      message: `${p.file}: ${p.message}`,
      fingerprint: specFindingFingerprint("unreadable", p.file),
    });
  for (const s of await staleFlows(handle, spec.flows, spec.header?.files ?? {}))
    findings.push({
      rule: "stale",
      target: s.flow,
      message: `${s.flow} cites ${s.files.join(", ")}, which changed since it was drafted; run atticus spec draft ${repo.id}`,
      fingerprint: specFindingFingerprint("stale", s.flow, s.files.join(",")),
      flow: s.flow,
    });
  // The check's confirmations go into the flow files.
  let confirmedNow = 0;
  for (const f of r.flows) {
    const was = spec.flows.find((x) => x.id === f.id)!;
    if (serializeRecord(was) === serializeRecord(f)) continue;
    await writeFlow(root, repo.id, f);
    confirmedNow++;
  }
  // Principle 4: a finding that comes back unchanged after a redraft becomes a question.
  const prev = await readSpecFindings(root, repo.id);
  const draftedAt = spec.header?.drafted?.at;
  const redrafted = !!prev && prev.draftedAt !== draftedAt;
  const now = (o.now ?? new Date()).toISOString();
  const lines = new Map<string, number>();
  const exists = async (a: string) => {
    const cut = a.lastIndexOf(":");
    const path = a.slice(0, cut);
    if (!lines.has(path)) {
      const t = await handle.readText(path).catch(() => undefined);
      lines.set(path, t === undefined ? 0 : t.replace(/\n$/, "").split(/\r?\n/).length);
    }
    const n = Number(a.slice(cut + 1));
    return n >= 1 && n <= lines.get(path)!;
  };
  const stored: SpecFinding[] = [];
  const toAsk: { fs: SpecCheckFinding[]; q: QuestionDraft }[] = [];
  // ADR 0089: who calls an entry point is asked at once, one question per component.
  const callers = new Map<string, { fs: SpecCheckFinding[]; labels: string[]; at: string[] }>();
  for (const f of findings) {
    const p = prev?.findings.find((x) => x.fingerprint === f.fingerprint);
    const seen = p ? (redrafted ? p.seen + 1 : p.seen) : 1;
    let evidence = f.evidence && (await exists(f.evidence)) ? f.evidence : undefined;
    if (!evidence && f.flow) {
      const t = spec.flows.find((x) => x.id === f.flow)?.trigger.evidence[0];
      const a = t?.path && t.line ? `${t.path}:${t.line}` : undefined;
      if (a && (await exists(a))) evidence = a;
    }
    const flow = f.flow ? spec.flows.find((x) => x.id === f.flow) : undefined;
    // A caller the catalog shows goes back to the assistant to name; only an unknown one is asked.
    if (f.rule === "caller-unknown" && !f.callers?.length && !p?.question && evidence && flow) {
      const c = callers.get(flow.component) ?? { fs: [], labels: [], at: [] };
      const t = r.triggers.find((x) => x.id === flow.trigger.ref);
      c.fs.push(f);
      c.labels.push(t?.label ?? flow.trigger.what);
      if (!c.at.includes(evidence)) c.at.push(evidence);
      callers.set(flow.component, c);
    } else if (!p?.question && seen >= 2 && evidence)
      toAsk.push({ fs: [f], q: findingQuestion(f, evidence) });
    stored.push({
      fingerprint: f.fingerprint,
      rule: f.rule,
      target: f.target,
      ...(f.evidence ? { evidence: f.evidence } : {}),
      message: f.message,
      seen,
      ...(p?.question ? { question: p.question } : {}),
    });
  }
  for (const [component, c] of callers)
    toAsk.push({
      fs: c.fs,
      q: {
        question: `Who calls ${c.labels.length === 1 ? "this entry point" : "these entry points"} of ${component}, and how does each call arrive (through which gateway, or direct)? ${c.labels.join("; ")}`,
        options: [],
        evidence: c.at,
        scope: "repo",
      },
    });
  const rerun = `atticus spec draft ${repo.id}`;
  const asked = await raiseQuestions(
    root,
    toAsk.map((x) => x.q),
    { step: "spec-check", repo: repo.id, command: `atticus spec check ${repo.id}`, rerun, at: now },
  );
  const questionIds: string[] = [];
  const callerIds = new Set<string>();
  for (const [i, x] of toAsk.entries()) {
    const q = asked.of[i];
    if (!q) continue;
    questionIds.push(q.id);
    if (x.fs[0]?.rule === "caller-unknown") callerIds.add(q.id);
    for (const f of x.fs) {
      const s = stored.find((y) => y.fingerprint === f.fingerprint)!;
      s.question = q.id;
    }
  }
  await writeSpecFindings(root, {
    schemaVersion: 1,
    repo: repo.id,
    checkedAt: now,
    ...(draftedAt ? { draftedAt } : {}),
    findings: stored,
  });
  if (spec.header && questionIds.length)
    await writeSpecHeader(root, {
      ...spec.header,
      questions: [...new Set([...spec.header.questions, ...questionIds])].sort(),
    });
  const steps = r.flows.reduce((n, f) => n + f.steps.length, 0);
  const covered = r.triggers.filter((t) => t.flow).length;
  if (o.json) {
    io.out(
      JSON.stringify(
        {
          repo: repo.id,
          template: templateRef(template),
          flows: r.flows.length,
          steps,
          confirmedByCheck: r.confirmed,
          triggers: { total: r.triggers.length, covered },
          findings: stored,
          questions: asked.raised.map((q) => q.id),
        },
        null,
        2,
      ),
    );
    return stored.length ? 1 : 0;
  }
  io.out(
    `${repo.id}: ${plural(r.flows.length, "flow")}, ${plural(steps, "step")}; ${covered} of ${plural(r.triggers.length, "trigger")} in the catalog have a flow; the check confirmed ${r.confirmed} ${r.confirmed === 1 ? "step" : "steps"} on its cited lines${confirmedNow ? ` (${plural(confirmedNow, "flow file")} updated)` : ""}.`,
  );
  if (r.unconfirmable)
    io.out(
      `  ${plural(r.unconfirmable, "step")} the check can't confirm (transforms, branches, validations, or nothing named to look for); the AI pass and your review confirm those.`,
    );
  if (stored.length === 0) {
    io.out("No findings.");
    return 0;
  }
  io.out(`${plural(stored.length, "finding")}:`);
  for (const f of stored)
    io.out(`  [${f.rule}] ${f.message}${f.question ? ` (question ${f.question})` : ""}`);
  const callerQs = asked.raised.filter((q) => callerIds.has(q.id));
  const backQs = asked.raised.filter((q) => !callerQs.includes(q));
  if (callerQs.length)
    io.out(
      `Nothing in the code or config says who calls some entry points, so ${callerQs.length === 1 ? "a question asks" : "questions ask"} a person in ${questionsRelOf(root)}/: ${callerQs.map((q) => q.id).join(", ")}`,
    );
  if (backQs.length)
    io.out(
      `${plural(backQs.length, "finding")} came back unchanged after a redraft, so ${backQs.length === 1 ? "it is" : "they are"} now ${backQs.length === 1 ? "a question" : "questions"} for a person in ${questionsRelOf(root)}/: ${backQs.map((q) => q.id).join(", ")}`,
    );
  for (const q of asked.reused) io.out(reusedLine(q));
  if (asked.raised.length)
    io.out(`Answer with atticus questions answer <id> --text "...", then run ${rerun}`);
  else io.out(`Next: ${rerun} hands the findings back to your assistant.`);
  return 1;
}
