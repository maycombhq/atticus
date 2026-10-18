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
  initiatives: (id) => (id ? ["initiative", "status", id] : ["initiative", "status"]),
};

export function uiKnowRoutes(r: Router, ctx: ServerContext): Router {
  const view = async (name: string, arg?: string) => {
    const build = VIEWS[name];
    if (!build) throw notFound(`There is no view ${name}.`);
    if (arg !== undefined && !ID.test(arg)) throw badRequest(`${arg} isn't an id.`);
    const args = build(arg);
    if (!args) throw badRequest(`The ${name} view needs a change id: /api/view/${name}/<change>.`);
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
  return r
    .add("GET", "/api/view/{name}", ({ params }) => view(params.name!))
    .add("GET", "/api/view/{name}/{id}", ({ params }) => view(params.name!, params.id!));
}
