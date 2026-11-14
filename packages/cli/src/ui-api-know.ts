import { Api } from "@maycombhq/core";
import { initiativeStatus, readView } from "@maycombhq/initiatives";
import { systemGuide } from "@maycombhq/site";
import { catalogRecords, openChanges } from "./site-commands.js";
import { baselineCommand, MACHINE_CHECKING, setupSteps } from "./baseline-commands.js";

import { doctorChecks, type DoctorCheck } from "./doctor.js";
import { keptAnswer } from "./watched-memo.js";
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

export function uiKnowRoutes(
  r: Router,
  ctx: ServerContext,
  o: {
    /** Start the machine checks now, as the server starts (`atticus ui`), not on the first request. */
    warm?: boolean;
    /** The machine checks; default doctor's (tests pass their own). */
    doctor?: (root: string) => Promise<DoctorCheck[]>;
  } = {},
): Router {
  // The app itself holds the default port: that isn't a problem to report.
  const doctor = o.doctor ?? ((root: string) => doctorChecks(root, { portFree: async () => true }));
  // The machine doesn't change between page loads: check it at most every five minutes. The
  // checks in flight are kept too, so a request while they run waits for them, not a second run.
  let checked: { at: number; checks: Promise<DoctorCheck[]> } | undefined;
  // beta.23: the last checks that finished, for Home, which never waits for the machine.
  let last: DoctorCheck[] | undefined;
  const machine = (fresh = false): Promise<DoctorCheck[]> => {
    if (fresh || !checked || Date.now() - checked.at > 300_000) {
      const run = { at: Date.now(), checks: doctor(ctx.root) };
      checked = run;
      run.checks.then(
        (c) => {
          if (checked === run) last = c;
        },
        // A run that failed is forgotten, so the next request checks again.
        () => {
          if (checked === run) checked = undefined;
        },
      );
    }
    return checked.checks;
  };
  /** The machine's checks if they have finished (the newest that did), else that they run. */
  const machineNow = (): DoctorCheck[] | typeof MACHINE_CHECKING => {
    // Started (or started again after five minutes) for the next look; this one doesn't wait.
    void machine().catch(() => undefined);
    return last ?? MACHINE_CHECKING;
  };
  // The Set up page's first load waited about 3 s for these (found on Windows): start them now.
  if (o.warm) void machine().catch(() => undefined);
  const view = async (name: string, arg?: string) => {
    // Review round 48: a view of this table's own, never the prototype's (toString, __proto__).
    const build = Object.hasOwn(VIEWS, name) ? VIEWS[name] : undefined;
    if (!build) throw notFound(`There is no view ${name}.`);
    if (arg !== undefined && !ID.test(arg)) throw badRequest(`${arg} isn't an id.`);
    const args = build(arg);
    if (!args) throw badRequest(`The ${name} view needs an id: /api/view/${name}/<id>.`);
    // Loaded when first used: main.ts imports the command that starts this server.
    const { main, capturedIo } = await import("./main.js");
    const out: string[] = [];
    const err: string[] = [];
    const code = await main([...args, "--json", "--root", ctx.root], capturedIo(out, err), {
      quiet: true,
    });
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
    // Nothing printed and a non-zero exit: the command said no in words (a feature that isn't
    // there, a view that can't be shown yet), never data for a page to read.
    if (body === null && code !== 0) {
      const words = err.join("\n").trim() || "The command gave no answer.";
      if (/^(There is no|No .+ (is|named) )/i.test(words)) throw notFound(words);
      throw new HttpError(
        422,
        "Atticus can't show that yet",
        words,
        scanFirst(words) ? { notYet: true } : undefined,
      );
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
    const { main, capturedIo } = await import("./main.js");
    const out: string[] = [];
    const err: string[] = [];
    const code = await main([...args, "--root", ctx.root], capturedIo(out, err), { quiet: true });
    if (code === 2) {
      const words = err.join("\n") || "The command refused the request.";
      // A refusal that names the step to take first (a scan) is an empty state, not a failure.
      if (scanFirst(words))
        throw new HttpError(422, "Atticus can't show that yet", words, { notYet: true });
      throw badRequest(words);
    }
    return { code, text: out.join("\n"), problems: err };
  };
  return (
    r
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
      // beta.23: Home's checklist never waits for the machine's checks (on Windows, starting Git,
      // the OpenSpec CLI and the Copilot language server took seconds): until they finish, the
      // machine step says it is checking. ?machine=wait waits for them, as it did before.
      .add("GET", "/api/setup", async ({ query }) => ({
        status: 200,
        body: await setupSteps(ctx.root, {
          doctor: query.get("machine") === "wait" ? machine() : machineNow(),
        }),
      }))
      .add("GET", "/api/doctor", async ({ query }) => {
        const checks = await machine(query.get("fresh") === "1");
        return { status: 200, body: { checks, ok: !checks.some((c) => c.status === "fail") } };
      })
      .add("POST", "/api/baseline", async ({ body }) => {
        const b = Api.BaselineRequest.safeParse(body ?? {});
        if (!b.success) throw badRequest("Some fields aren't right.");
        // Accepting the catalog writes catalog/baseline.yaml with the person's name; it reaches
        // main through a pull request like any other metarepo file (ADR 0073). No role is checked.
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
      .add("GET", "/api/diagram/{view}/graph", async ({ params, query }) => {
        const name = params.view!;
        if (!DIAGRAM_VIEWS.includes(name) || name === "sequence")
          throw badRequest(
            `${name} has no canvas. Views: ${DIAGRAM_VIEWS.filter((v) => v !== "sequence").join(", ")}.`,
          );
        const focus = query.get("focus") ?? undefined;
        if (focus !== undefined && !ID.test(focus)) throw badRequest(`${focus} isn't an id.`);
        const r = await text([
          "diagram",
          "render",
          name,
          "--format",
          "json",
          ...(focus ? ["--focus", focus] : []),
        ]);
        const out = r.text.trim();
        if (!out.startsWith("{")) {
          const words = r.problems.join("\n") || "Nothing to draw.";
          throw new HttpError(
            422,
            "Atticus can't show that yet",
            words,
            scanFirst(words) ? { notYet: true } : undefined,
          );
        }
        return { status: 200, body: { view: JSON.parse(out) as unknown } };
      })
      // The API's own coverage (ADR 0021): the view's `api` part, in the Coverage schema.
      .add("GET", "/api/coverage", async () => {
        const r = await view("coverage");
        const data = r.body.data as { api?: unknown } | null;
        return { status: 200, body: data?.api ?? { areas: [], systems: [] } };
      })
      // beta.23: Home's triage list, kept until a change is heard (watched-memo.ts); the other
      // views run as they did.
      .add("GET", "/api/view/{name}", ({ params }) =>
        params.name === "triage"
          ? keptAnswer(ctx.root, "view:triage", () => view("triage"))
          : view(params.name!),
      )
      .add("GET", "/api/view/{name}/{id}", ({ params }) => view(params.name!, params.id!))
  );
}
