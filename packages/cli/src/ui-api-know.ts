import { Api } from "@maycombhq/core";
import { initiativeStatus, readView } from "@maycombhq/initiatives";
import { systemGuide } from "@maycombhq/site";
import { catalogRecords, openChanges } from "./site-commands.js";
import { baselineCommand, setupSteps } from "./baseline-commands.js";
import { meView } from "./ui-api-me.js";
import { doctorChecks, type DoctorCheck } from "./doctor.js";
import {
  badRequest,
  HttpError,
  notFound,
  type Router,
  type ServerContext,
} from "@maycombhq/server";

/**
 * Read-only views for the Know, Define, Design, Plan and Build screens (ADR 0043): each runs one
 * `atticus … --json` command, the same the terminal runs, and returns its JSON. Only commands
 * that read files are listed; nothing here writes.
 */

const ID = /^[a-z0-9][a-z0-9._-]*$/;

/** View name → the CLI arguments, given the optional path argument. */
const VIEWS: Record<string, (arg?: string) => string[] | undefined> = {
  coverage: () => ["coverage"],
  questions: () => ["questions"],
  intake: () => ["intake", "list"],
  triage: () => ["triage"],
  features: (id) => (id ? ["feature", "show", id] : ["feature", "list"]),
  glossary: () => ["glossary", "list"],
  "critic-stats": () => ["critic", "stats"],
  conflicts: () => ["change", "conflicts"],
  findings: (id) => (id ? ["findings", id] : undefined),
  drift: (id) => (id ? ["drift", id] : undefined),
  trace: (id) => (id ? ["trace", id, "--no-write"] : undefined),
  "story-bar": (id) => (id ? ["plan", "bar", id] : undefined),
  sources: () => ["sources", "sync"],
  initiatives: (id) => (id ? ["initiative", "status", id] : undefined),
  reconcile: () => ["reconcile"],
};

/** Diagram views `atticus diagram render` draws as Mermaid text; container and sequence need a focus. */
const DIAGRAM_VIEWS = ["context", "container", "data", "event", "sequence"];

/** A refusal that names the step to take first (a scan): the app shows it as an empty state. */
const scanFirst = (words: string) => /catalog is empty|scan first/i.test(words);

export function uiKnowRoutes(r: Router, ctx: ServerContext): Router {
  // The machine doesn't change between page loads: check it at most every five minutes.
  let checked: { at: number; checks: DoctorCheck[] } | undefined;
  const machine = async (fresh = false) => {
    if (fresh || !checked || Date.now() - checked.at > 300_000)
      checked = {
        at: Date.now(),
        // The app itself holds the default port: that isn't a problem to report.
        checks: await doctorChecks(ctx.root, { portFree: async () => true }),
      };
    return checked.checks;
  };
  const view = async (name: string, arg?: string) => {
    const build = VIEWS[name];
    if (!build) throw notFound(`There is no view ${name}.`);
    if (arg !== undefined && !ID.test(arg)) throw badRequest(`${arg} isn't an id.`);
    const args = build(arg);
    if (!args) throw badRequest(`The ${name} view needs an id: /api/view/${name}/<id>.`);
    // Loaded when first used: main.ts imports the command that starts this server.
    const { main } = await import("./main.js");
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      [...args, "--json", "--root", ctx.root],
      { out: (l) => out.push(l), err: (l) => err.push(l) },
      { quiet: true },
    );
    const text = out.join("\n").trim();
    if (code === 2) {
      const words = err.join("\n") || "The command refused the request.";
      // A refusal that names the step to take first (a scan) is an empty state, not a failure.
      if (scanFirst(words))
        throw new HttpError(422, "Atticus can't show that yet", words, { notYet: true });
      throw badRequest(words);
    }
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // A command that printed words, not JSON, on a refusal.
      body = undefined;
    }
    if (body === undefined) {
      const words = [...err, ...out].join("\n") || "No output.";
      // A refusal that names the step to take first (a scan) is an empty state, not a failure.
      throw new HttpError(
        422,
        "Atticus can't show that yet",
        words,
        scanFirst(words) ? { notYet: true } : undefined,
      );
    }
    return { status: 200, body: { code, data: body, problems: err } };
  };
  /** Run a command that prints text, not JSON; returns the text. */
  const text = async (args: string[]) => {
    const { main } = await import("./main.js");
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      [...args, "--root", ctx.root],
      { out: (l) => out.push(l), err: (l) => err.push(l) },
      { quiet: true },
    );
    if (code === 2) {
      const words = err.join("\n") || "The command refused the request.";
      // A refusal that names the step to take first (a scan) is an empty state, not a failure.
      if (scanFirst(words))
        throw new HttpError(422, "Atticus can't show that yet", words, { notYet: true });
      throw badRequest(words);
    }
    return { code, text: out.join("\n"), problems: err };
  };
  return r
    .add("POST", "/api/triage/{itemId}/decide", async ({ params, body }) => {
      const b = Api.TriageDecideRequest.safeParse(body ?? {});
      if (!b.success)
        throw badRequest("Some fields aren't right.", {
          errors: b.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      const { triageDecide } = await import("./intake-commands.js");
      const out: string[] = [];
      const err: string[] = [];
      const code = await triageDecide(
        ctx.root,
        params.itemId!,
        b.data.option,
        { by: ctx.user, ...(b.data.reason ? { reason: b.data.reason } : {}) },
        { out: (l) => out.push(l), err: (l) => err.push(l) },
      );
      if (code !== 0) {
        const detail = [...err, ...out].join("\n") || "Atticus refused.";
        if (/There is no open triage item/.test(detail)) throw notFound(detail);
        throw code === 2 ? badRequest(detail) : new HttpError(422, "Atticus refused", detail);
      }
      ctx.events.publish({ type: "file.changed", path: "catalog/curated" });
      return { status: 200, body: { item: params.itemId, option: b.data.option, lines: out } };
    })
    .add("GET", "/api/setup", async () => ({
      status: 200,
      body: await setupSteps(ctx.root, { doctor: await machine() }),
    }))
    .add("GET", "/api/doctor", async ({ query }) => {
      const checks = await machine(query.get("fresh") === "1");
      return { status: 200, body: { checks, ok: !checks.some((c) => c.status === "fail") } };
    })
    .add("POST", "/api/baseline", async ({ body }) => {
      const b = Api.BaselineRequest.safeParse(body ?? {});
      if (!b.success) throw badRequest("Some fields aren't right.");
      // Accepting the catalog is a catalog decision: when roles.yaml names who may make those
      // (approvals.catalog-assert), only they may; ownership decides, never the view.
      const op = await import("@maycombhq/core").then((m) =>
        m.loadOrgPack(m.orgPackDirOf(ctx.root)),
      );
      if (op.roles.approvals["catalog-assert"]) {
        const me = await meView(ctx.root, ctx.user);
        if (!me.approvals.some((a) => a.action === "catalog-assert"))
          throw new HttpError(
            403,
            "You can't accept the catalog",
            "roles.yaml says who may make catalog decisions (approvals.catalog-assert); ask one of them.",
          );
      }
      const out: string[] = [];
      const err: string[] = [];
      const code = await baselineCommand(
        ctx.root,
        { by: ctx.user, ...(b.data.note ? { note: b.data.note } : {}) },
        { out: (l) => out.push(l), err: (l) => err.push(l) },
      );
      if (code !== 0) throw new HttpError(422, "Atticus refused", [...err, ...out].join("\n"));
      ctx.events.publish({ type: "file.changed", path: "catalog/baseline.yaml" });
      return {
        status: 200,
        body: { lines: out, ...(await setupSteps(ctx.root, { doctor: await machine() })) },
      };
    })
    .add("GET", "/api/guide/{system}", async ({ params }) => {
      const id = params.system!;
      if (!ID.test(id)) throw badRequest(`${id} isn't an id.`);
      try {
        return {
          status: 200,
          body: systemGuide(await catalogRecords(ctx.root), id, {
            changes: await openChanges(ctx.root),
          }),
        };
      } catch (e) {
        throw notFound((e as Error).message);
      }
    })
    .add("GET", "/api/initiatives", async () => {
      const v = await readView(ctx.root);
      const body = [];
      for (const i of v.all("Initiative").sort((a, b) => a.id.localeCompare(b.id)))
        body.push(await initiativeStatus(ctx.root, i.id));
      return { status: 200, body };
    })
    .add("GET", "/api/diagram/{view}", async ({ params, query }) => {
      const name = params.view!;
      if (!DIAGRAM_VIEWS.includes(name))
        throw badRequest(`${name} isn't a view. Views: ${DIAGRAM_VIEWS.join(", ")}.`);
      const focus = query.get("focus") ?? undefined;
      if (focus !== undefined && !ID.test(focus)) throw badRequest(`${focus} isn't an id.`);
      return {
        status: 200,
        body: await text(["diagram", "render", name, ...(focus ? ["--focus", focus] : [])]),
      };
    })
    .add("GET", "/api/view/{name}", ({ params }) => view(params.name!))
    .add("GET", "/api/view/{name}/{id}", ({ params }) => view(params.name!, params.id!));
}
