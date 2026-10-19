import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { changeReport } from "@maycombhq/changes";
import { RunSummary } from "@maycombhq/core";
import { traceMatrix } from "@maycombhq/testgen";
import { REQUESTS_FILE, type ReleaseContext } from "./context.js";
import { sectionOf } from "./model.js";
import { outcomesView } from "./outcomes.js";

/**
 * The evidence pack: everything an approval board or an auditor needs, generated from the
 * change folder on every read. Change summary, every file with its sha-256 (checked against
 * what each hand-off recorded), critic rounds and findings with their resolutions, waivers
 * with who and why, approvals on the hand-off PRs, the test trace, service requests and the
 * manual steps done, the drift result and AI run summaries. Each item names its source file.
 */

export interface EvidenceFile {
  /** Relative to the change folder, forward slashes. */
  path: string;
  sha256: string;
  bytes: number;
}

export interface EvidencePack {
  change: string;
  title: string;
  generatedAt: string;
  files: EvidenceFile[];
  markdown: string;
}

async function walk(dir: string, rel = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(dir, p)));
    else if (e.isFile() && !e.name.endsWith(".tmp")) out.push(p);
  }
  return out;
}

/** Every file of the change folder with its sha-256. */
export async function changeFiles(dir: string): Promise<EvidenceFile[]> {
  const out: EvidenceFile[] = [];
  for (const path of await walk(dir)) {
    const buf = await readFile(join(dir, path));
    out.push({ path, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length });
  }
  return out;
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const day = (iso?: string) => (iso ? iso.slice(0, 10) : "");

export async function evidencePack(ctx: ReleaseContext): Promise<EvidencePack> {
  const files = await changeFiles(ctx.dir);
  const c = ctx.change;
  const md: string[] = [];
  const h2 = (t: string) => {
    if (md.at(-1) !== "") md.push("");
    md.push(`## ${t}`, "");
  };
  md.push(
    `# Evidence pack: ${c.id}`,
    "",
    `${c.title}. Generated ${ctx.now} by Atticus from the files of the change folder (\`openspec/changes/${c.id}/\`); nothing here is typed by hand, and every item names the file it came from.`,
  );

  // ---- summary
  h2("Change summary");
  let risk: string;
  try {
    const rep = await changeReport(ctx.root, c.id);
    risk = `${rep.risk.level} (score ${rep.risk.score})`;
  } catch {
    risk = "couldn't be assessed";
  }
  md.push(
    `| | |`,
    `| --- | --- |`,
    `| Change | ${c.id} |`,
    `| Title | ${esc(c.title)} |`,
    `| Type | ${c.type} |`,
    `| State | ${c.state} |`,
    `| Risk | ${risk} |`,
    `| Systems | ${c.systems.join(", ") || "none named"} |`,
    `| Owners | ${Object.entries(c.owners)
      .map(([r, p]) => `${r}: ${p.join(", ")}`)
      .join("; ")} |`,
    `| Created | ${c.createdAt} by ${c.createdBy} |`,
    "",
    "Source: change.yaml",
  );
  const problem = sectionOf(ctx, "brief.md", /^problem/i);
  const outcome = sectionOf(ctx, "brief.md", /^outcome/i);
  for (const s of [problem, outcome])
    if (s) md.push("", `**${s.heading}.** ${s.text.replace(/\n/g, " ")} (${s.source})`);
  if (c.history.length) {
    md.push("", "State history:", "");
    for (const x of c.history)
      md.push(
        `- ${x.at}: ${x.from} → ${x.to} by ${x.by}${x.pr ? ` (PR #${x.pr})` : ""}${x.reason ? `: ${x.reason}` : ""}`,
      );
    md.push("", "Source: change.yaml history");
  }

  // ---- artifacts
  h2("Artifacts and their sha-256");
  const recorded = new Map<string, { phase: string; sha256: string }>();
  for (const hf of c.handoffs)
    for (const a of hf.artifacts) recorded.set(a.path, { phase: hf.phase, sha256: a.sha256 });
  if (recorded.size)
    md.push("| File | Bytes | sha-256 | Against the hand-off |", "| --- | --- | --- | --- |");
  else md.push("| File | Bytes | sha-256 |", "| --- | --- | --- |");
  for (const f of files) {
    const r = recorded.get(f.path);
    const against = !r
      ? "not in a hand-off"
      : r.sha256 === f.sha256
        ? `matches ${r.phase}`
        : `changed since ${r.phase} (${r.sha256.slice(0, 12)}…)`;
    md.push(`| ${f.path} | ${f.bytes} | \`${f.sha256}\` |${recorded.size ? ` ${against} |` : ""}`);
  }
  if (!recorded.size)
    md.push("", "_No hand-off recorded artifact hashes, so there is nothing to compare against._");

  // ---- critic rounds
  h2("Critic rounds and findings");
  const rounds = ctx.rounds.filter((r) => r.gate !== "drift");
  if (!rounds.length) md.push("_No critic round has run on this change yet._");
  for (const r of rounds) {
    const open = r.findings.filter((f) => f.finding.state === "open").length;
    md.push(
      `### ${r.gate} gate, round ${r.round}${r.meta?.createdAt ? ` (${r.meta.createdAt})` : ""}`,
      "",
      `${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}, ${open} open. Source: review/${r.gate}/${r.round}/`,
      "",
    );
    if (r.findings.length) {
      md.push(
        "| Finding | Severity | Rule | State | Summary | Resolution | Source |",
        "| --- | --- | --- | --- | --- | --- | --- |",
      );
      for (const { finding: f, path } of r.findings) {
        const res = f.resolution
          ? `${f.resolution.action} by ${f.resolution.by} ${day(f.resolution.at)}${f.resolution.reason ? `: ${esc(f.resolution.reason)}` : ""}${f.resolution.askedOf ? ` (asked of ${f.resolution.askedOf})` : ""}`
          : "";
        md.push(
          `| ${f.id} | ${f.severity} | ${f.rule} | ${f.state} | ${esc(f.summary)} | ${res} | ${path} |`,
        );
      }
      md.push("");
    }
  }

  // ---- waivers
  h2("Waivers");
  const waived = ctx.rounds.flatMap((r) => r.findings).filter((f) => f.finding.state === "waived");
  const uniq = waived.filter(
    (w, i, a) =>
      a.findIndex(
        (x) =>
          x.finding.gate === w.finding.gate &&
          x.finding.rule === w.finding.rule &&
          x.finding.summary === w.finding.summary,
      ) === i,
  );
  if (!uniq.length)
    md.push(
      rounds.length ? "_No finding is waived._" : "_No critic round yet, so nothing is waived._",
    );
  for (const { finding: f, path } of uniq)
    md.push(
      `- ${f.summary} Rule ${f.rule} (${f.layer}), waived by ${f.resolution?.by ?? "?"} on ${day(f.resolution?.at)}: ${f.resolution?.reason ?? "no reason recorded"} (${path})`,
    );

  // ---- approvals
  h2("Approvals (hand-off PRs)");
  if (!c.handoffs.length) md.push("_No hand-off PR yet._");
  for (const hf of c.handoffs) {
    md.push(
      `- ${hf.phase}: PR #${hf.pr.number} ${hf.pr.url}, ${hf.state}, raised by ${hf.by} ${day(hf.openedAt)}; ${hf.approvals.length ? `approved by ${hf.approvals.map((a) => `${a.by} as ${a.roles.join(", ")} (${a.at})`).join("; ")}` : "no approvals yet"}.`,
    );
  }
  if (c.handoffs.length) md.push("", "Source: change.yaml handoffs");

  // ---- test trace
  h2("Test trace");
  try {
    const t = await traceMatrix(ctx.root, c.id);
    const byKind = new Map<string, number>();
    for (const g of t.gaps) byKind.set(g.kind, (byKind.get(g.kind) ?? 0) + 1);
    const tested = t.rows.filter((r) => r.tests.length).length;
    md.push(
      `${t.requirements.length} requirement${t.requirements.length === 1 ? "" : "s"}, ${t.stories.length} stor${t.stories.length === 1 ? "y" : "ies"}, ${t.rows.length} trace row${t.rows.length === 1 ? "" : "s"} of which ${tested} ha${tested === 1 ? "s" : "ve"} a test; ${t.found.length} test file${t.found.length === 1 ? "" : "s"} found in the repos.`,
    );
    if (t.gaps.length) {
      md.push("", "Gaps:", "");
      for (const [k, n] of [...byKind].sort()) md.push(`- ${k}: ${n}`);
    }
    md.push(
      "",
      "Source: computed as `atticus trace` does, from specs/, stories/, tests/ and Run with AI records",
    );
  } catch (e) {
    md.push(`_The trace couldn't be computed: ${(e as Error).message}_`);
  }

  // ---- service requests and steps
  h2("Service requests and manual steps");
  if (!ctx.requests.length) md.push(`_${REQUESTS_FILE} drafts no service request._`);
  for (const r of ctx.requests)
    md.push(
      `- ${r.heading}: ${r.state === "filed" ? `filed${r.number ? ` as ${r.number}` : ""}${r.filedAt ? ` on ${day(r.filedAt)}` : ""}` : r.state === "waiting" ? `waiting for a person to file it (step ${r.step})` : "not filed"}${r.missing.length ? `; missing ${r.missing.join(", ")}` : ""} (${REQUESTS_FILE}:${r.line})`,
    );
  const steps = [...ctx.steps].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1,
  );
  if (steps.length) {
    md.push(
      "",
      "| Step | System | What | State | Done by | Source |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const s of steps)
      md.push(
        `| ${s.id} | ${s.system} | ${esc(s.title)} | ${s.state} | ${s.recorded ? `${s.recorded.by} ${s.recorded.at}${s.recorded.via === "executor" ? ` via ${s.recorded.executor ?? "an executor"}` : ""}` : ""} | steps/${s.id}.yaml |`,
      );
  } else md.push("", "_No manual step for this change._");

  // ---- drift
  h2("Drift");
  const drift = ctx.rounds.filter((r) => r.gate === "drift").at(-1);
  if (!drift)
    md.push(
      "_No drift check has run on this change (it runs in build and qa, and after each scan)._",
    );
  else {
    const open = drift.findings.filter((f) => f.finding.state === "open");
    md.push(
      `Newest round ${drift.round}${drift.meta?.createdAt ? ` (${drift.meta.createdAt})` : ""}: ${open.length ? `${open.length} open drift finding${open.length === 1 ? "" : "s"}` : "no open drift"}. Source: review/drift/${drift.round}/`,
    );
    for (const f of open) md.push(`- ${f.finding.summary} (${f.path})`);
  }

  // ---- AI runs
  h2("AI run summaries");
  const runs: string[] = [];
  for (const f of files.filter((x) => /(^|\/)runs\/[^/]+\.ya?ml$/.test(x.path))) {
    try {
      const s = RunSummary.safeParse(parse(await readFile(join(ctx.dir, f.path), "utf8")));
      if (s.success)
        runs.push(
          `- ${s.data.runId}: ${s.data.agent} on ${s.data.runtime}, ${s.data.state}, ${s.data.startedAt}${s.data.usage ? `, ${s.data.usage.inputTokens} in / ${s.data.usage.outputTokens} out tokens` : ""}; context sha-256 \`${s.data.contextManifestSha256.slice(0, 12)}…\` (${f.path})`,
        );
    } catch {
      // not a run summary
    }
  }
  for (const r of rounds)
    for (const l of r.meta?.lenses ?? [])
      runs.push(
        `- ${r.gate} round ${r.round}, ${l.lens} lens: ${l.agent}, ${l.state}${l.reason ? ` (${l.reason})` : ""}${l.promptSha256 ? `; prompt sha-256 \`${l.promptSha256.slice(0, 12)}…\`` : ""} (review/${r.gate}/${r.round}/meta/round.yaml)`,
      );
  md.push(...(runs.length ? runs : ["_No AI run is recorded for this change._"]));

  // ---- outcomes
  h2("Outcomes");
  const o = await outcomesView(ctx);
  if (!o.measures.length) md.push(`_${o.gaps[0] ?? "The brief names no success measures."}_`);
  for (const m of o.measures)
    md.push(
      `- ${m.measure} (${m.source}): ${m.latest ? `${m.latest.value}, measured by ${m.latest.by} on ${day(m.latest.at)} (review/outcomes.yaml)` : "not measured yet"}`,
    );

  return {
    change: c.id,
    title: c.title,
    generatedAt: ctx.now,
    files,
    markdown: md.join("\n") + "\n",
  };
}

/** Write the pack to a folder: evidence.md, manifest.json and a copy of every file under files/. */
export async function writeEvidencePack(ctx: ReleaseContext, out: string): Promise<string[]> {
  const pack = await evidencePack(ctx);
  await mkdir(out, { recursive: true });
  const written = ["evidence.md", "manifest.json"];
  await writeFile(join(out, "evidence.md"), pack.markdown, "utf8");
  await writeFile(
    join(out, "manifest.json"),
    JSON.stringify(
      { change: pack.change, generatedAt: pack.generatedAt, files: pack.files },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  for (const f of pack.files) {
    const to = join(out, "files", ...f.path.split("/"));
    await mkdir(dirname(to), { recursive: true });
    await copyFile(join(ctx.dir, ...f.path.split("/")), to);
    written.push(`files/${f.path}`);
  }
  return written;
}
