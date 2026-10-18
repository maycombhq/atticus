import { Api } from "@maycombhq/core";
import { initiativeStatus, readView } from "@maycombhq/initiatives";
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

export function uiKnowRoutes(r: Router, ctx: ServerContext): Router {
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
    const code = await main([...args, "--json", "--root", ctx.root], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    const text = out.join("\n").trim();
    if (code === 2) throw badRequest(err.join("\n") || "The command refused the request.");
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // A command that printed words, not JSON, on a refusal.
      body = undefined;
    }
    if (body === undefined)
      throw new HttpError(
        422,
        "Atticus can't show that yet",
        [...err, ...out].join("\n") || "No output.",
      );
    return { status: 200, body: { code, data: body, problems: err } };
  };
  /** Run a command that prints text, not JSON; returns the text. */
  const text = async (args: string[]) => {
    const { main } = await import("./main.js");
    const out: string[] = [];
    const err: string[] = [];
    const code = await main([...args, "--root", ctx.root], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    if (code === 2) throw badRequest(err.join("\n") || "The command refused the request.");
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
