import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  fileStepStore,
  manualAdapter,
  stepOfProvisional,
  type ServiceDesk,
} from "@maycombhq/adapters";
import {
  Api,
  inputsDirOf,
  loadOrgPack,
  orgPackDirOf,
  MANUAL_SYSTEMS,
  type ChangeLifecycle,
  type ExecutorConfig,
  type Finding,
  type ManualStep,
  type OrgPack,
} from "@maycombhq/core";
import { archiveGate } from "@maycombhq/ci";
import { changeFolder, changeReport, changeStore, detectConflicts } from "@maycombhq/changes";
import { listReports, readQuality } from "@maycombhq/evals";
import { inputsSha256, loadExecutors } from "@maycombhq/executors";
import { readServiceRequestExports, readWorkItemExports } from "@maycombhq/intake";
import { isSandbox, lessonsFor, readProgress, type Check, type Lesson } from "@maycombhq/learn";
import {
  layerRules,
  loadConstitution,
  overrideStats,
  readChangeFiles,
  readPackFiles,
  readRound,
  readSnowDrafts,
  reviewedGates,
  roundsOf,
} from "@maycombhq/naysayer";
import { SYNC_FILE } from "@maycombhq/planner";
import { readChangeRepos } from "@maycombhq/workspace";
import {
  badRequest,
  HttpError,
  notFound,
  strParam,
  type Router,
  type ServerContext,
} from "@maycombhq/server";
import type { Output } from "./commands.js";
import { changeArchive } from "./change-commands.js";
import { criticStats } from "./critic-commands.js";
import { defencesScan, evalRun } from "./eval-commands.js";
import { learnCheck, learnStart, sandboxCreate } from "./learn-commands.js";
import { snowDraft, snowSubmit } from "./plan-commands.js";
import { ciArchiveGate } from "./quality-commands.js";
import { executorsCheck, todoDone, todoRun, todoShow, type TodoDeps } from "./todo-commands.js";
import { conformanceCommand } from "./u1-commands.js";
import type { UiDeps } from "./ui-api.js";

/**
 * Local API calls for the Release and Run screens (ADR 0043): to-do and manual steps, the
 * release plan, the service desk queue, governance, AI quality, learning and settings. Reads
 * come from the metarepo's files through the libraries; every write runs the CLI's own command
 * function, as the signed-in person, so the screen and `atticus …` never disagree. Nothing here
 * calls an outside system: filing a service-desk request from the app makes a step a person
 * does in the desk, and live evals (a real model) stay in the terminal.
 */

export interface RunDeps extends UiDeps {
  /** Executors and clock for `todo run` (tests); otherwise .atticus/executors.yaml. */
  todo?: TodoDeps;
  /** Tests inject a service desk; otherwise the manual one (steps for a person). */
  serviceDesk?: ServiceDesk;
}

interface Ran {
  code: number;
  out: string[];
  err: string[];
}

async function run(f: (io: Output) => Promise<number>): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await f({ out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

/** A command's refusal (422) or usage error (400), in its own words. */
function refused(r: Ran): HttpError {
  const detail = (r.err.length ? r.err : r.out).join("\n") || "The command refused.";
  return r.code === 2
    ? new HttpError(400, "The request isn't valid", detail)
    : new HttpError(422, "Atticus can't do that yet", detail, { lines: [...r.out, ...r.err] });
}

function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success)
    throw badRequest("Some fields aren't right.", {
      errors: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  return r.data;
}

/** The JSON a command printed with --json, or undefined when it printed words instead. */
function jsonOf<T>(r: Ran): T | undefined {
  const text = r.out.join("\n").trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

async function readChange(root: string, id: string): Promise<ChangeLifecycle> {
  try {
    return await changeStore(root).read(id);
  } catch {
    throw notFound(`There is no change ${id}.`);
  }
}

async function openChanges(root: string): Promise<ChangeLifecycle[]> {
  return (await changeStore(root).list())
    .filter((c) => c.state !== "archived")
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function latestFindings(root: string, change: string): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const gate of await reviewedGates(root, change)) {
    const rounds = await roundsOf(root, change, gate);
    if (rounds.length)
      out.push(
        ...(await readRound(root, change, gate, rounds.at(-1)!)).findings.map((f) => f.finding),
      );
  }
  return out;
}

/** Every file under a folder, relative and with forward slashes. */
async function filesUnder(dir: string, prefix = ""): Promise<{ path: string; bytes: number }[]> {
  const out: { path: string; bytes: number }[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await filesUnder(join(dir, e.name), rel)));
    else out.push({ path: rel, bytes: (await stat(join(dir, e.name))).size });
  }
  return out;
}

const RUNTIME_KIND: Record<string, keyof OrgPack["runtime"]["adapters"]> = {
  "work-tracker": "workTracker",
  "service-desk": "serviceDesk",
  "git-host": "gitHost",
  wiki: "wiki",
  notify: "notify",
  design: "design",
};

async function executorsOf(root: string, deps: RunDeps) {
  return deps.todo?.executors
    ? { executors: deps.todo.executors, problems: [] as string[] }
    : await loadExecutors(root);
}

// ------------------------------------------------------------------ steps

/** A step id, with the change when two changes use the same id. */
const stepRef = (id: string, change?: string) => (change ? `${change}/${id}` : id);

function stepView(s: ManualStep, all: ManualStep[], pack: OrgPack, configured: Set<string>) {
  const proc = s.procedure ? pack.procedures.find((p) => p.id === s.procedure) : undefined;
  return {
    id: s.id,
    ...(s.change ? { change: s.change } : {}),
    system: s.system,
    action: s.action,
    state: s.state,
    title: s.title,
    where: s.where,
    ...(s.procedure ? { procedure: s.procedure } : {}),
    ...(s.procedureStep ? { procedureStep: s.procedureStep } : {}),
    fields: s.fields.map((f) => ({
      name: f.name,
      value: f.value,
      ...(f.help ? { help: f.help } : {}),
    })),
    instructions: s.instructions,
    result: s.result,
    waitsFor: s.dependsOn.filter((d) => all.find((x) => x.id === d)?.state === "open"),
    ...(s.reason ? { reason: s.reason } : {}),
    ...(s.recorded ? { recorded: s.recorded } : {}),
    runs: s.runs.map((r) => ({
      runId: r.runId,
      executor: r.executor,
      at: r.at,
      status: r.status,
      mode: r.mode,
      by: r.approval.by,
      ...(r.message ? { message: r.message } : {}),
    })),
    /** Executors that may do this step: the procedure allows them and this person has them. */
    executors: (proc?.executors.allowed ?? []).filter((n) => configured.has(n)),
    createdAt: s.createdAt,
    createdBy: s.createdBy,
  };
}

async function findStep(root: string, id: string, change?: string): Promise<ManualStep> {
  const all = await fileStepStore(root).list(change ? { change } : {});
  const s = all.find((x) => x.id === id);
  if (!s) throw notFound(`There is no step ${stepRef(id, change)}.`);
  return s;
}

// ------------------------------------------------------------------ service desk

type Template = OrgPack["serviceRequests"][number];

interface RequestView {
  change: string;
  heading: string;
  template?: string;
  requestType: string;
  record: string;
  leadTimeDays?: number;
  approvers: string[];
  fields: { name: string; value: string; required: boolean }[];
  missing: string[];
  state: "to-file" | "waiting" | "filed";
  step?: string;
  number?: string;
  url?: string;
}

const SyncEntries = z.object({
  requests: z.array(z.object({ key: z.string(), id: z.string() })).default([]),
});

/** snow.md's drafts for a change, matched to templates, with what was filed (sync.yaml, steps). */
async function changeRequests(
  root: string,
  change: string,
  templates: Template[],
  steps: ManualStep[],
): Promise<RequestView[]> {
  const dir = changeFolder(root, change);
  const drafts = readSnowDrafts(await readChangeFiles(dir));
  if (drafts.length === 0) return [];
  let synced: { key: string; id: string }[] = [];
  try {
    synced = SyncEntries.parse(parse(await readFile(join(dir, SYNC_FILE), "utf8"))).requests;
  } catch {
    // nothing filed yet
  }
  return drafts.map((d) => {
    const h = d.heading.toLowerCase();
    const t = templates.find((x) =>
      [x.requestType, x.name, x.id].some((n) => h.includes(n.toLowerCase())),
    );
    const record = /:\s*(\S+)\s*$/.exec(d.heading)?.[1] ?? "";
    const fields = t
      ? t.fields.map((f) => ({
          name: f.name,
          value: d.fields.get(f.name.toLowerCase())?.value ?? "",
          required: f.required,
        }))
      : [...d.fields].map(([name, v]) => ({ name, value: v.value, required: false }));
    const base = {
      change,
      heading: d.heading,
      ...(t ? { template: t.id, leadTimeDays: t.leadTimeDays } : {}),
      requestType: t?.requestType ?? d.heading,
      record,
      approvers: t?.approvers ?? [],
      fields,
      missing: fields.filter((f) => f.required && !f.value.trim()).map((f) => f.name),
    };
    const entry = t ? synced.find((e) => e.key === `${t.id}|${record}`) : undefined;
    if (!entry) return { ...base, state: "to-file" as const };
    const stepId = stepOfProvisional(entry.id);
    if (!stepId) return { ...base, state: "filed" as const, number: entry.id };
    const s = steps.find((x) => x.id === stepId);
    const v = s?.state === "done" ? s.recorded?.values : undefined;
    return typeof v?.requestNumber === "string"
      ? {
          ...base,
          state: "filed" as const,
          step: stepId,
          number: v.requestNumber,
          ...(typeof v.url === "string" ? { url: v.url } : {}),
        }
      : { ...base, state: "waiting" as const, step: stepId };
  });
}

// ------------------------------------------------------------------ learning

function questionOf(check: Check): string | undefined {
  if (check.type === "answer") return check.question;
  if (check.type === "all")
    for (const c of check.checks) if (c.type === "answer") return c.question;
  return undefined;
}

const commandLine = (argv: string[]) =>
  `atticus ${argv.map((a) => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ")}`;

function stepOfLesson(l: Lesson, id: string) {
  const s = l.steps.find((x) => x.id === id);
  if (!s) return undefined;
  const q = questionOf(s.check);
  return {
    id: s.id,
    n: l.steps.indexOf(s) + 1,
    title: s.title,
    body: s.body,
    commands: s.do.map(commandLine),
    ...(q ? { question: q } : {}),
    hint: s.hint,
  };
}

// ------------------------------------------------------------------ routes

const ALL = new Set(["1", "true", "yes"]);

export function uiRunRoutes(r: Router, ctx: ServerContext, deps: RunDeps = {}): Router {
  const { root, user } = ctx;
  const nowDate = deps.now ? () => new Date(deps.now!) : undefined;
  const pack = () => loadOrgPack(orgPackDirOf(root));

  return (
    r
      // ---------------------------------------------------------------- to-do
      .add("GET", "/api/todo", async ({ query }) => {
        const change = strParam(query, "change");
        const op = await pack();
        let steps: ManualStep[];
        try {
          steps = await fileStepStore(root).list(change ? { change } : {});
        } catch (e) {
          throw new HttpError(422, "A step file can't be read", (e as Error).message);
        }
        const all = ALL.has(strParam(query, "all") ?? "");
        const ex = await executorsOf(root, deps);
        const configured = new Set(ex.executors.map((e) => e.name));
        const inputs = { root, inputsDir: inputsDirOf(root) };
        const [items, requests] = await Promise.all([
          readWorkItemExports(inputs),
          readServiceRequestExports(inputs),
        ]);
        return {
          status: 200,
          body: {
            steps: steps
              .filter((s) => all || s.state === "open")
              .map((s) => stepView(s, steps, op, configured)),
            sources: MANUAL_SYSTEMS.map((system) => ({
              system,
              configured: op.runtime.adapters[RUNTIME_KIND[system]!]?.type ?? null,
              open: steps.filter((s) => s.system === system && s.state === "open").length,
            })),
            exports: {
              workItems: items.items.length,
              requests: requests.requests.length,
              files: [...new Set([...items.files, ...requests.files])].sort(),
            },
            procedures: op.procedures.map((p) => {
              const runs = steps
                .filter((s) => s.procedure === p.id)
                .flatMap((s) => s.runs)
                .sort((a, b) => (a.at < b.at ? -1 : 1));
              const last = runs.at(-1);
              return {
                id: p.id,
                name: p.name,
                system: p.system,
                status: p.status,
                steps: p.steps.length,
                writes: p.steps.filter((s) => s.writes).length,
                allowed: p.executors.allowed,
                configured: p.executors.allowed.filter((n) => configured.has(n)),
                runs: runs.length,
                ...(last
                  ? { lastRun: { at: last.at, status: last.status, executor: last.executor } }
                  : {}),
              };
            }),
            executors: { configured: [...configured].sort(), problems: ex.problems },
          },
        };
      })
      .add("GET", "/api/todo/{stepId}/export", async ({ params, query }) => {
        const format = strParam(query, "format") ?? "text";
        const res = await run((io) =>
          todoShow(
            root,
            stepRef(params.stepId!, strParam(query, "change")),
            { export: format },
            io,
          ),
        );
        if (res.code === 0) return { status: 200, body: { format, text: res.out.join("\n") } };
        if (res.err.some((l) => /^There is no step/.test(l))) throw notFound(res.err.join("\n"));
        throw refused(res);
      })
      .add("POST", "/api/todo/{stepId}/done", async ({ params, body }) => {
        const b = parseBody(Api.StepDoneRequest, body);
        const ref = stepRef(params.stepId!, b.change);
        const res = await run((io) =>
          todoDone(
            root,
            ref,
            {
              by: user,
              result: b.values,
              ...(b.skip ? { skip: true } : {}),
              ...(b.note ? { note: b.note } : {}),
            },
            io,
            deps.todo ?? {},
          ),
        );
        if (res.code !== 0) {
          if (res.err.some((l) => /^There is no step/.test(l))) throw notFound(res.err.join("\n"));
          throw refused(res);
        }
        ctx.events.publish({ type: "file.changed", path: `steps/${params.stepId}` });
        const s = await findStep(root, params.stepId!, b.change);
        return { status: 200, body: { ...s, lines: res.out } };
      })
      .add("GET", "/api/todo/{stepId}/run", async ({ params, query }) => {
        const s = await findStep(root, params.stepId!, strParam(query, "change"));
        const op = await pack();
        const proc = s.procedure ? op.procedures.find((p) => p.id === s.procedure) : undefined;
        const configured = new Set((await executorsOf(root, deps)).executors.map((e) => e.name));
        const allowed = (proc?.executors.allowed ?? []).filter((n) => configured.has(n));
        const want = strParam(query, "with");
        const step = proc?.steps.find((x) => x.id === s.procedureStep);
        return {
          status: 200,
          body: {
            step: s.id,
            inputs: s.inputs,
            inputsSha256: inputsSha256(s.inputs),
            executors: allowed,
            ...(want ? { allowed: allowed.includes(want) } : {}),
            writes: step?.writes ?? false,
            ...(proc ? { procedure: proc.id } : {}),
          },
        };
      })
      .add("POST", "/api/todo/{stepId}/run", async ({ params, body }) => {
        const b = parseBody(Api.StepRunRequest, body);
        const res = await run((io) =>
          todoRun(
            root,
            stepRef(params.stepId!, b.change),
            {
              with: b.with,
              approve: user,
              inputs: b.inputsSha256,
              ...(b.fillOnly ? { fillOnly: true } : {}),
            },
            io,
            deps.todo ?? {},
          ),
        );
        if (res.code !== 0) {
          if (res.err.some((l) => /^There is no step/.test(l))) throw notFound(res.err.join("\n"));
          throw refused(res);
        }
        ctx.events.publish({ type: "file.changed", path: `steps/${params.stepId}` });
        return {
          status: 200,
          body: { step: await findStep(root, params.stepId!, b.change), lines: res.out },
        };
      })

      // ---------------------------------------------------------------- service desk
      .add("GET", "/api/service-desk", async ({ query }) => {
        const only = strParam(query, "change");
        const op = await pack();
        const steps = await fileStepStore(root)
          .list({ system: "service-desk" })
          .catch(() => [] as ManualStep[]);
        const requests: RequestView[] = [];
        for (const c of await openChanges(root))
          if (!only || c.id === only)
            requests.push(...(await changeRequests(root, c.id, op.serviceRequests, steps)));
        const exported = await readServiceRequestExports({ root, inputsDir: inputsDirOf(root) });
        const ex = await executorsOf(root, deps);
        const configured = new Set(ex.executors.map((e) => e.name));
        return {
          status: 200,
          body: {
            adapter: { configured: op.runtime.adapters.serviceDesk?.type ?? null },
            exports: { requests: exported.requests.length, files: exported.files },
            templates: op.serviceRequests.map((t) => ({
              id: t.id,
              name: t.name,
              requestType: t.requestType,
              leadTimeDays: t.leadTimeDays,
            })),
            executors: op.procedures
              .filter((p) => p.system === "service-desk")
              .flatMap((p) => p.executors.allowed.filter((n) => configured.has(n)))
              .filter((n, i, a) => a.indexOf(n) === i),
            requests,
          },
        };
      })
      .add("POST", "/api/service-desk/{changeId}/draft", async ({ params, body }) => {
        await readChange(root, params.changeId!);
        const b = parseBody(Api.DraftRequestsRequest, body);
        const res = await run((io) =>
          snowDraft(root, params.changeId!, b.force ? { force: true } : {}, io),
        );
        // Exit 1 with no complaint means "written, with fields for a person to fill".
        if (res.code !== 0 && (res.code !== 1 || res.err.length)) throw refused(res);
        ctx.events.publish({ type: "file.changed", path: `${params.changeId}/snow.md` });
        return { status: 200, body: { lines: res.out, toFill: res.code === 1 } };
      })
      .add("POST", "/api/service-desk/{changeId}/submit", async ({ params }) => {
        await readChange(root, params.changeId!);
        const op = await pack();
        const desk =
          deps.serviceDesk ??
          (manualAdapter(
            "serviceDesk",
            {
              store: fileStepStore(root),
              root,
              change: params.changeId!,
              procedures: op.procedures,
              ...(deps.now ? { now: () => deps.now! } : {}),
            },
            op.runtime.adapters.serviceDesk?.settings ?? {},
          ) as ServiceDesk);
        const res = await run((io) =>
          snowSubmit(root, params.changeId!, { approve: user }, io, {
            serviceDesk: desk,
            ...(nowDate ? { now: nowDate } : {}),
          }),
        );
        if (res.code !== 0) throw refused(res);
        ctx.events.publish({ type: "file.changed", path: `${params.changeId}/sync.yaml` });
        return { status: 200, body: { lines: res.out } };
      })

      // ---------------------------------------------------------------- release
      .add("GET", "/api/release", async () => {
        const at = new Set(["release-ready", "released", "post-release-review"]);
        const list = (await openChanges(root)).map((c) => ({
          id: c.id,
          title: c.title,
          type: c.type,
          state: c.state,
          atRelease: at.has(c.state),
        }));
        list.sort((a, b) => Number(b.atRelease) - Number(a.atRelease));
        return { status: 200, body: list };
      })
      .add("GET", "/api/release/{changeId}", async ({ params }) => {
        const id = params.changeId!;
        const c = await readChange(root, id);
        const op = await pack();
        const rep = await changeReport(root, id);
        const findings = await latestFindings(root, id);
        const open = { blocking: 0, gap: 0, risk: 0, idea: 0 };
        for (const f of findings) if (f.state === "open") open[f.severity] += 1;
        const steps = await fileStepStore(root)
          .list({ change: id })
          .catch(() => [] as ManualStep[]);
        const requests = await changeRequests(root, id, op.serviceRequests, steps);
        const gate = op.gates.gates.find((g) => g.phase === "release");
        const design = (await readChangeFiles(changeFolder(root, id))).docs.get("design.md");
        const sec = design?.sections.find((s) =>
          /rollout|rollback|release|deploy/i.test(s.heading),
        );
        const repos = (await readChangeRepos(root, id).catch(() => undefined))?.repos ?? [];
        const conflicts = (await detectConflicts(root).catch(() => []))
          .filter((p) => p.changes.includes(id))
          .map((p) => ({ with: p.changes.find((x) => x !== id)!, overlap: p.overlap }));
        const archive = await archiveGate(root, id).catch((e: Error) => ({
          pass: false,
          blockers: [{ code: "error", message: e.message }],
          notes: [] as string[],
        }));
        const handoff = c.handoffs.filter((h) => h.phase === "release").at(-1);
        return {
          status: 200,
          body: {
            change: { id: c.id, title: c.title, type: c.type, state: c.state, owners: c.owners },
            status: {
              state: rep.state,
              ...(rep.phase ? { phase: rep.phase } : {}),
              ...(rep.next ? { next: rep.next } : {}),
              nextStep: rep.nextStep,
              risk: rep.risk,
              required: rep.required,
              blockers: rep.blockers,
              reasons: rep.reasons,
            },
            ...(gate
              ? { releaseApprovers: { roles: gate.approvers, min: gate.minApprovals } }
              : {}),
            ...(handoff
              ? {
                  handoff: {
                    state: handoff.state,
                    pr: handoff.pr.url,
                    approvals: handoff.approvals,
                    reviewers: handoff.reviewers,
                  },
                }
              : {}),
            openFindings: open,
            requests: {
              total: requests.length,
              filed: requests.filter((x) => x.state !== "to-file").length,
              toFile: requests.filter((x) => x.state === "to-file").length,
              list: requests,
            },
            repos: repos.map((x) => ({
              id: x.id,
              branch: x.branch,
              ...(x.pr ? { pr: x.pr } : {}),
              build: x.build,
            })),
            ...(sec && design
              ? {
                  rollout: {
                    heading: sec.heading,
                    text: design.lines.slice(sec.line, sec.end).join("\n").trim(),
                  },
                }
              : {}),
            conflicts,
            archive: { pass: archive.pass, blockers: archive.blockers, notes: archive.notes },
            evidence: await filesUnder(changeFolder(root, id)),
          },
        };
      })
      .add("POST", "/api/release/{changeId}/archive", async ({ params, body }) => {
        const id = params.changeId!;
        await readChange(root, id);
        const b = parseBody(Api.ArchiveRequest, body);
        const gate = await run((io) => ciArchiveGate(root, id, {}, io));
        if (gate.code !== 0) throw refused(gate);
        const res = await run((io) =>
          changeArchive(
            root,
            id,
            { by: user, ...(b.rescan === false ? { rescan: false } : {}) },
            io,
          ),
        );
        if (res.code !== 0) throw refused(res);
        ctx.events.publish({ type: "file.changed", path: id });
        return { status: 200, body: { lines: [...gate.out, ...res.out] } };
      })

      // ---------------------------------------------------------------- governance
      .add("GET", "/api/governance", async () => {
        const conf = jsonOf<{
          kind: string;
          target: string;
          passed: boolean;
          results: unknown[];
          summary: { pass: number; fail: number; warn: number };
        }>(
          await run((io) =>
            conformanceCommand(orgPackDirOf(root), { kind: "org-pack", json: true }, io),
          ),
        );
        const constitution = await loadConstitution();
        const org = await readPackFiles(root, join(orgPackDirOf(root), "checklists"));
        const team = await readPackFiles(root, join(orgPackDirOf(root), "teams"));
        const layered = layerRules([
          { pack: constitution, file: "built-in", origin: "constitution" },
          ...org.packs.map((p) => ({ ...p, origin: "org" as const })),
          ...team.packs.map((p) => ({ ...p, origin: "team" as const })),
        ]);
        const changes = await openChanges(root);
        const waivers = [];
        const separation = [];
        for (const c of changes) {
          for (const f of await latestFindings(root, c.id))
            if (f.state === "waived")
              waivers.push({
                change: c.id,
                gate: f.gate,
                rule: f.rule,
                summary: f.summary,
                ...(f.resolution
                  ? { by: f.resolution.by, at: f.resolution.at, reason: f.resolution.reason }
                  : {}),
              });
          const rep = await changeReport(root, c.id).catch(() => undefined);
          for (const x of [...(rep?.blockers ?? []), ...(rep?.reasons ?? [])])
            if (/separation|self-approval/.test(x.code))
              separation.push({ change: c.id, code: x.code, message: x.message });
        }
        const stats = jsonOf(await run((io) => criticStats(root, { json: true }, io)));
        const count = (packs: { pack: { rules: unknown[] } }[]) =>
          packs.reduce((a, p) => a + p.pack.rules.length, 0);
        return {
          status: 200,
          body: {
            conformance: conf
              ? { ...conf, target: "org-pack" }
              : {
                  kind: "org-pack",
                  passed: false,
                  results: [],
                  summary: { pass: 0, fail: 0, warn: 0 },
                },
            rules: {
              constitution: constitution.rules.length,
              org: count(org.packs),
              team: count(team.packs),
              inForce: layered.rules.length,
              waivable: layered.rules.filter((x) => x.waivable).length,
              refused: layered.refused,
              problems: [...org.problems, ...team.problems, ...layered.problems],
            },
            waivers: waivers.filter(
              (w, i, a) =>
                a.findIndex(
                  (x) => x.change === w.change && x.rule === w.rule && x.gate === w.gate,
                ) === i,
            ),
            overrides: stats ?? { changes: 0, rules: [], suggestions: [] },
            separation: separation.filter(
              (s, i, a) =>
                a.findIndex((x) => x.change === s.change && x.message === s.message) === i,
            ),
          },
        };
      })

      // ---------------------------------------------------------------- AI quality
      .add("GET", "/api/evals", async () => {
        const op = await pack();
        const stats = await overrideStats(root);
        const t = { total: 0, applied: 0, dismissed: 0, waived: 0, asked: 0, open: 0 };
        for (const x of stats.rules) {
          t.total += x.total;
          t.applied += x.applied;
          t.dismissed += x.dismissed;
          t.waived += x.waived;
          t.asked += x.asked;
          t.open += x.open;
        }
        return {
          status: 200,
          body: {
            quality: (await readQuality(root)) ?? null,
            runs: (await listReports(root)).map((x) => ({
              runId: x.runId,
              mode: x.mode,
              startedAt: x.startedAt,
              finishedAt: x.finishedAt,
              runs: x.runs,
              agents: x.agents,
              failed: x.results.filter((c) => !c.pass).length,
              skipped: x.skipped.length,
              ...(x.liveBar ? { liveBar: x.liveBar.pass } : {}),
            })),
            findings: t,
            modes: op.runtime.modes,
            models: op.runtime.models.allowed,
          },
        };
      })
      .add("POST", "/api/evals/run", async ({ body }) => {
        const b = parseBody(Api.EvalRunRequest, body);
        if (b.mode === "live")
          throw badRequest(
            "Live evals call a real model, so the app doesn't start them. Run atticus eval run --mode live in a terminal.",
          );
        const res = await run((io) =>
          evalRun(
            root,
            {
              mode: b.mode,
              json: true,
              ...(b.agents ? { agent: b.agents } : {}),
              ...(b.runs ? { runs: b.runs } : {}),
            },
            io,
            nowDate ? { now: nowDate } : {},
          ),
        );
        const out = jsonOf<Record<string, unknown>>(res);
        if (res.code === 2 || !out) throw refused(res.code === 2 ? res : { ...res, code: 1 });
        ctx.events.publish({ type: "file.changed", path: ".evals/quality.json" });
        return { status: 200, body: { ...out, problems: res.err } };
      })
      .add("GET", "/api/evals/defences", async () => {
        const res = await run((io) => defencesScan(root, undefined, { json: true }, io));
        const scan = jsonOf<{ files: unknown[]; scanned: number; skipped: number }>(res) ?? {
          files: [],
          scanned: 0,
          skipped: 0,
        };
        const items = [];
        for (const c of await openChanges(root)) {
          const dir = join(changeFolder(root, c.id), "review", "defences");
          for (const f of (await readdir(dir).catch(() => [] as string[])).sort()) {
            if (!f.endsWith(".json")) continue;
            try {
              const list = JSON.parse(await readFile(join(dir, f), "utf8")) as {
                source: string;
                origin: string;
                summary: string;
                fix: string;
                question: string;
                signals: unknown[];
              }[];
              for (const q of list)
                items.push({
                  change: c.id,
                  file: `review/defences/${f}`,
                  source: q.source,
                  origin: q.origin,
                  summary: q.summary,
                  fix: q.fix,
                  question: q.question,
                  signals: q.signals.length,
                });
            } catch {
              // a file being written; the next read has it
            }
          }
        }
        return { status: 200, body: { ...scan, items, problems: res.err } };
      })

      // ---------------------------------------------------------------- learning
      .add("GET", "/api/learning", async () => {
        const { lessons, problems } = await lessonsFor(root);
        const sandbox = await isSandbox(root);
        const progress = sandbox ? await readProgress(root) : undefined;
        const view = lessons.map((l) => {
          const p = progress?.lessons[l.id];
          const done = p ? l.steps.filter((s) => p.steps[s.id]).length : 0;
          return {
            id: l.id,
            role: l.role,
            title: l.title,
            summary: l.summary,
            minutes: l.minutes,
            steps: l.steps.length,
            done,
            state: !p ? "not-started" : p.completedAt ? "done" : "in-progress",
          };
        });
        const roles = [...new Set(lessons.map((l) => l.role))].map((role) => ({
          role,
          lessons: view.filter((v) => v.role === role).length,
          done: view.filter((v) => v.role === role && v.state === "done").length,
        }));
        const cur = progress?.current ? lessons.find((l) => l.id === progress.current) : undefined;
        const lp = cur ? progress!.lessons[cur.id] : undefined;
        const next = cur?.steps.find((s) => !lp?.steps[s.id]);
        return {
          status: 200,
          body: {
            sandbox,
            roles,
            lessons: view,
            ...(cur
              ? {
                  current: {
                    lesson: cur.id,
                    title: cur.title,
                    intro: cur.intro,
                    steps: cur.steps.length,
                    completed: !next,
                    ...(next ? { step: stepOfLesson(cur, next.id) } : { outro: cur.outro }),
                  },
                }
              : {}),
            problems,
          },
        };
      })
      .add("POST", "/api/learning/start", async ({ body }) => {
        const b = parseBody(Api.StartLessonRequest, body);
        const res = await run((io) =>
          learnStart(root, b.lesson, { json: true }, io, nowDate ? { now: nowDate() } : {}),
        );
        const out = jsonOf<Record<string, unknown>>(res);
        if (res.code !== 0 || !out) throw refused(res);
        return { status: 200, body: out };
      })
      .add("POST", "/api/learning/check", async ({ body }) => {
        const b = parseBody(Api.CheckLessonRequest, body);
        const res = await run((io) =>
          learnCheck(
            root,
            {
              json: true,
              ...(b.answer !== undefined && b.answer !== "" ? { answer: b.answer } : {}),
              ...(b.lesson ? { lesson: b.lesson } : {}),
              ...(b.step ? { step: b.step } : {}),
            },
            io,
            nowDate ? { now: nowDate() } : {},
          ),
        );
        const out = jsonOf<{ lesson: string; step: string; pass: boolean }>(res);
        if (!out) throw refused(res.code === 0 ? { ...res, code: 1 } : res);
        let hint: string | undefined;
        if (!out.pass) {
          const l = (await lessonsFor(root)).lessons.find((x) => x.id === out.lesson);
          hint = l?.steps.find((s) => s.id === out.step)?.hint;
        }
        return { status: 200, body: { ...out, ...(hint ? { hint } : {}) } };
      })
      .add("POST", "/api/learning/sandbox", async ({ body }) => {
        const b = parseBody(Api.SandboxRequest, body);
        const res = await run((io) =>
          sandboxCreate(resolve(b.dir), { json: true }, io, nowDate ? { now: nowDate() } : {}),
        );
        const out = jsonOf<Record<string, unknown>>(res);
        if (res.code !== 0 || !out) throw refused(res);
        return { status: 201, body: out };
      })

      // ---------------------------------------------------------------- settings
      .add("GET", "/api/settings", async () => {
        const op = await pack();
        const rt = op.runtime;
        const ex = await executorsOf(root, deps);
        const names = new Set(ex.executors.map((e) => e.name));
        const kinds = [
          "workTracker",
          "serviceDesk",
          "gitHost",
          "wiki",
          "notify",
          "design",
          "model",
        ] as const;
        return {
          status: 200,
          body: {
            runtime: {
              assistants: rt.assistants,
              editors: rt.editors,
              modes: rt.modes,
              models: rt.models,
              autonomy: rt.autonomy,
              budgets: rt.budgets,
              retention: rt.retention,
              telemetry: rt.telemetry,
              buildEngine: rt.buildEngine ?? { default: "speckit", perRepo: {} },
            },
            adapters: kinds.map((kind) => {
              const cfg = rt.adapters[kind];
              return {
                kind,
                type: cfg?.type ?? null,
                mode: !cfg
                  ? "not-set"
                  : cfg.type === "manual"
                    ? "manual"
                    : cfg.type === "mock"
                      ? "mock"
                      : "live",
              };
            }),
            executors: {
              configured: ex.executors.map((e: ExecutorConfig) => ({
                name: e.name,
                transport: e.transport,
                where: e.transport === "http" ? e.url : [e.command, ...e.args].join(" "),
                fillOnly: e.fillOnly,
                covers: [...e.procedures, ...e.stepKinds],
                allowedFor: op.procedures
                  .filter((p) => p.executors.allowed.includes(e.name))
                  .map((p) => p.id),
              })),
              missing: op.procedures.flatMap((p) =>
                p.executors.allowed
                  .filter((n) => !names.has(n))
                  .map((n) => ({ procedure: p.id, executor: n })),
              ),
              problems: ex.problems,
            },
            orgPack: {
              platforms: op.profiles.map((p) => p.platform),
              ...(op.pack ? { pack: op.pack } : {}),
              counts: {
                patterns: op.patterns.length,
                dialects: op.dialects.length,
                checklists: op.checklists.length,
                agents: op.agents.length,
                procedures: op.procedures.length,
                serviceRequests: op.serviceRequests.length,
                profiles: op.profiles.length,
                skills: op.skills.length,
              },
              defaulted: op.defaulted,
              problems: op.problems,
            },
            gates: op.gates.gates.map((g) => ({
              id: g.id,
              phase: g.phase,
              approvers: g.approvers,
              minApprovals: g.minApprovals,
              checklists: g.checklists,
              checks: g.checks.map((c) => c.check),
              maxAuthorRounds: g.maxAuthorRounds,
            })),
          },
        };
      })
      .add("GET", "/api/settings/executors/check", async () => {
        const res = await run((io) => executorsCheck(root, { json: true }, io, deps.todo ?? {}));
        const out = jsonOf<Record<string, unknown>>(res);
        if (!out) throw refused({ ...res, code: 1 });
        return { status: 200, body: out };
      })
  );
}
