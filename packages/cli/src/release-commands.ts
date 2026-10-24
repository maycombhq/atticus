import { resolve } from "node:path";
import {
  AUDIENCES,
  deploymentPlan,
  evidencePack,
  loadRelease,
  outcomesView,
  recordOutcome,
  releaseForecast,
  releaseNotes,
  ReleaseError,
  securityReview,
  writeEvidencePack,
  type Audience,
  type DeploymentPlan,
  type ReleaseForecast,
} from "@maycombhq/release";
import { changeStore } from "@maycombhq/changes";
import type { AiRuntime } from "@maycombhq/ai";
import type { Output } from "./commands.js";
import { judgingRuntime } from "./judging.js";

/**
 * atticus release … and atticus outcome …: the generated views of a change for releasing it
 * (deployment plan, forecast, evidence pack, release notes, security review draft) and the
 * outcome records people keep after release. Views are computed from files on every run, so
 * they never go stale. Whether an API change breaks callers, which sentences undo a step, which
 * lines name a secret and which columns are personal are judgments (ADR 0117 addendum): read
 * from judgments/, asked of the judge when runtime.yaml's runtime calls a model directly, and
 * otherwise shown as not judged. Exit 0 ok (gaps are part of the view, said in words), 1
 * refused (no such change, a value before release), 2 usage.
 */

export interface ReleaseDeps {
  now?: () => Date;
  /** The judge's runtime; default runtime.yaml's, null for none. */
  runtime?: AiRuntime | null;
}

function fail(io: Output, e: unknown): number {
  if (e instanceof ReleaseError) {
    io.err(e.message);
    return e.code === "usage" ? 2 : 1;
  }
  throw e;
}

const load = async (root: string, id: string, deps: ReleaseDeps) => {
  const runtime = await judgingRuntime(root, deps.runtime);
  return loadRelease(root, id, {
    ...(deps.now ? { now: deps.now() } : {}),
    ...(runtime ? { runtime } : {}),
  });
};

function lines(io: Output, text: string) {
  for (const l of text.replace(/\n$/, "").split("\n")) io.out(l);
}

function planText(p: DeploymentPlan, f: ReleaseForecast): string[] {
  const out = [`Deployment plan for ${p.change} (${p.state}), ${p.today}`, ""];
  for (const w of p.before)
    out.push(
      `0. Before anything: ${w.requestType}${w.record ? ` for ${w.record}` : ""} (${w.state}${w.readyBy ? `, ready by ${w.readyBy}` : ""}). ${w.source}`,
    );
  for (const s of p.steps) {
    out.push(`${s.n}. ${s.repo} (${s.kind})${s.waitDays ? `, from ${s.earliest}` : ""}`);
    for (const w of s.what) out.push(`   - ${w}`);
    for (const y of s.why) out.push(`   why: ${y}`);
    for (const w of s.waitsOn)
      out.push(
        `   waits on: ${w.requestType}${w.record ? ` for ${w.record}` : ""}, ${w.state === "filed" ? `filed${w.number ? ` as ${w.number}` : ""}` : w.state === "waiting" ? "waiting for a person to file it" : "not filed"}${w.readyBy ? `, ready by ${w.readyBy} (${w.waitDays} working days)` : ""}${w.missing.length ? `; missing ${w.missing.join(", ")}` : ""}`,
      );
    out.push(
      `   rollback: ${s.rollback.text ? `${s.rollback.text} (${s.rollback.source})` : `GAP: ${s.rollback.gap}`}`,
    );
  }
  if (!p.steps.length)
    out.push("No repo to deploy: the change names no interface, data change, task or repo.");
  for (const x of p.external)
    out.push(`External: ${x.what}${x.beforeStep ? `, before step ${x.beforeStep}` : ""}.`);
  out.push("", "Release sections (design.md):");
  for (const s of p.sections)
    out.push(`  ${s.name}: ${s.text ? `${s.heading} (${s.source})` : `GAP: ${s.gap}`}`);
  if (p.findings.length) {
    out.push("", "Release lens findings still open:");
    for (const x of p.findings) out.push(`  ${x.severity}: ${x.summary} (${x.path})`);
  }
  out.push(
    "",
    `Forecast: ${f.ready ? `ready by ${f.ready}` : "no date"}${f.target ? `, target ${f.target.date} (${f.status})` : ""}.`,
  );
  for (const d of f.drivers) out.push(`  ${d.until}: ${d.what}. ${d.source}`);
  const gaps = p.gaps.filter(
    (g) => !/^No rollback step (written|judged)|^design\.md (has no|says nothing)/.test(g),
  );
  if (gaps.length) {
    out.push("", "Gaps:");
    for (const g of gaps) out.push(`  - ${g}`);
  }
  for (const n of [...p.notes, ...f.notes]) out.push(`Note: ${n}`);
  return out;
}

/** atticus release plan <change> [--json] */
export async function releasePlanCommand(
  root: string,
  id: string | undefined,
  o: { json?: boolean },
  io: Output,
  deps: ReleaseDeps = {},
): Promise<number> {
  if (!id) {
    io.err("Usage: atticus release plan <change> [--json]");
    return 2;
  }
  try {
    const ctx = await load(root, id, deps);
    const plan = await deploymentPlan(ctx);
    const forecast = await releaseForecast(ctx, plan);
    if (o.json) io.out(JSON.stringify({ ...plan, forecast }, null, 2));
    else for (const l of planText(plan, forecast)) io.out(l);
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus release forecast <change> [--json] */
export async function releaseForecastCommand(
  root: string,
  id: string | undefined,
  o: { json?: boolean },
  io: Output,
  deps: ReleaseDeps = {},
): Promise<number> {
  if (!id) {
    io.err("Usage: atticus release forecast <change> [--json]");
    return 2;
  }
  try {
    const f = await releaseForecast(await load(root, id, deps));
    if (o.json) {
      io.out(JSON.stringify(f, null, 2));
      return 0;
    }
    io.out(
      f.status === "released"
        ? `${f.change} is released${f.ready ? ` (${f.ready})` : ""}.`
        : `${f.change}: ready by ${f.ready} (${f.waitDays} working days)${f.target ? `; target ${f.target.date}, ${f.status} (${f.target.source})` : "; no target date"}.`,
    );
    for (const d of f.drivers) io.out(`  ${d.until}: ${d.what}. ${d.source}`);
    for (const n of f.notes) io.out(`Note: ${n}`);
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus release evidence <change> [--out <dir>] [--json] */
export async function releaseEvidenceCommand(
  root: string,
  id: string | undefined,
  o: { out?: string; json?: boolean },
  io: Output,
  deps: ReleaseDeps = {},
): Promise<number> {
  if (!id) {
    io.err("Usage: atticus release evidence <change> [--out <dir>] [--json]");
    return 2;
  }
  try {
    const ctx = await load(root, id, deps);
    if (o.out) {
      const dir = resolve(o.out);
      const written = await writeEvidencePack(ctx, dir);
      if (o.json) io.out(JSON.stringify({ out: dir, written }, null, 2));
      else
        io.out(
          `Wrote the evidence pack for ${id} to ${dir}: evidence.md, manifest.json and ${written.length - 2} files.`,
        );
      return 0;
    }
    const pack = await evidencePack(ctx);
    if (o.json) io.out(JSON.stringify(pack, null, 2));
    else lines(io, pack.markdown);
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus release notes <change> [--audience business|technical] [--json] */
export async function releaseNotesCommand(
  root: string,
  id: string | undefined,
  o: { audience?: string; json?: boolean },
  io: Output,
  deps: ReleaseDeps = {},
): Promise<number> {
  const audience = (o.audience ?? "business") as Audience;
  if (!id || !AUDIENCES.includes(audience)) {
    io.err("Usage: atticus release notes <change> [--audience business|technical] [--json]");
    return 2;
  }
  try {
    const n = await releaseNotes(await load(root, id, deps), audience);
    if (o.json) io.out(JSON.stringify(n, null, 2));
    else lines(io, n.markdown);
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus release security <change> [--json] */
export async function releaseSecurityCommand(
  root: string,
  id: string | undefined,
  o: { json?: boolean },
  io: Output,
  deps: ReleaseDeps = {},
): Promise<number> {
  if (!id) {
    io.err("Usage: atticus release security <change> [--json]");
    return 2;
  }
  try {
    const s = await securityReview(await load(root, id, deps));
    if (o.json) io.out(JSON.stringify(s, null, 2));
    else lines(io, s.markdown);
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus outcome list [--change id] [--json] */
export async function outcomeList(
  root: string,
  o: { change?: string; json?: boolean },
  io: Output,
  deps: ReleaseDeps = {},
): Promise<number> {
  try {
    const ids = o.change ? [o.change] : (await changeStore(root).list()).map((c) => c.id).sort();
    const views = [];
    for (const id of ids) views.push(await outcomesView(await load(root, id, deps)));
    if (o.json) {
      io.out(JSON.stringify(o.change ? views[0] : views, null, 2));
      return 0;
    }
    if (!views.length) io.out("No changes yet.");
    for (const v of views) {
      io.out(`${v.change} (${v.state}): ${v.title}`);
      if (!v.measures.length) io.out(`  ${v.gaps[0] ?? "No success measures."}`);
      for (const m of v.measures)
        io.out(
          `  ${m.n}. ${m.measure} [${m.id}]: ${m.latest ? `${m.latest.value} (${m.latest.by}, ${m.latest.at.slice(0, 10)})` : "not measured yet"}`,
        );
      for (const x of v.orphans)
        io.out(`  ! ${x.id}: recorded, but brief.md no longer has this measure`);
      if (v.why && v.measures.length) io.out(`  ${v.why}`);
    }
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus outcome record <change> <measure> --value <v> [--by <you>] [--note text] */
export async function outcomeRecord(
  root: string,
  id: string | undefined,
  measure: string | undefined,
  o: { value?: string; by?: string; note?: string; json?: boolean },
  io: Output,
  deps: ReleaseDeps = {},
): Promise<number> {
  if (!id || !measure || !o.value?.trim() || !o.by) {
    io.err(
      'Usage: atticus outcome record <change> <measure id or number> --value "<what you measured>" [--by <you>] [--note "<how>"]',
    );
    return 2;
  }
  try {
    const r = await recordOutcome(await load(root, id, deps), {
      measure,
      value: o.value,
      by: o.by,
      ...(o.note ? { note: o.note } : {}),
    });
    if (o.json) io.out(JSON.stringify(r, null, 2));
    else
      io.out(
        `Recorded "${r.value.value}" for ${r.measure.id} as ${r.value.by}. Wrote ${r.written}.`,
      );
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}
