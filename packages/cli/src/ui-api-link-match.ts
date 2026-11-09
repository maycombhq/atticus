import { Api, currentSignal, loadOrgPack, orgPackDirOf } from "@maycombhq/core";
import { badRequest, conflict, type Router, type ServerContext } from "@maycombhq/server";
import type { AcpStepRunner } from "./copilot-acp-steps.js";
import { copilotAcpAllowed } from "./copilot-acp-steps.js";
import { matchDone, quotesOf, readMatch, runMatch } from "./link-match.js";
import { boxesOf, candidatesOf } from "./ui-api-links.js";

/**
 * ADR 0178, part 2: Match with Copilot from the Connect panel. POST starts one session (the
 * same guard rails as a Copilot run: allowed by runtime.yaml, one AI step at a time) that reads
 * the brief and writes only its answer file; GET says where it stands and gives the answer,
 * checked, as proposals. Where copilot-acp isn't allowed, POST writes the brief for Copilot
 * Chat and answers `handoff`; the person runs it there and GET reads the answer back.
 */

const keyOf = (from: string, to: Api.LinkBoxT) =>
  `${from}\u0000${to.repo ?? ""}\u0000${to.system ?? ""}`;

export function uiLinkMatchRoutes(
  r: Router,
  ctx: ServerContext,
  deps: { runner?: AcpStepRunner } = {},
): Router {
  // The session under way per pair of boxes, so GET can say "running" and POST refuse a second.
  const running = new Map<string, { jobId: string; error?: string }>();
  return (
    r
      .add("GET", "/api/links/match", async ({ query }) => {
        const { from, to } = boxesOf(query);
        const { view } = await candidatesOf(ctx.root, from, to);
        const run = running.get(keyOf(from, to));
        const job = run ? ctx.jobs.get(run.jobId) : undefined;
        if (run && job?.state === "running") {
          const files = await readMatch(ctx.root, view);
          return {
            status: 200,
            body: {
              ...files,
              state: "running",
              jobId: run.jobId,
              proposals: [],
              none: [],
              rejected: [],
            } satisfies Api.MatchLinksViewT,
          };
        }
        const m = await readMatch(ctx.root, view);
        // A failed run is said once more until an answer reads, or a new run starts.
        if (run?.error && m.state === "handoff") {
          m.state = "failed";
          m.error = run.error;
        }
        return { status: 200, body: m };
      })
      // Ninth UX walk (ADR 0181): Read the answer of a hand-off Match is its run's Done: the
      // answer is checked and what passes the citation check and the bar is applied as the AI's.
      .add("POST", "/api/links/match/done", async ({ body }) => {
        const b = Api.MatchLinksRequest.safeParse(body ?? {});
        if (!b.success)
          throw badRequest("Say both boxes: { from: <repo>, to: { repo } | { system } }.");
        const { from, to } = b.data;
        const { view, facts } = await candidatesOf(ctx.root, from, to);
        const run = running.get(keyOf(from, to));
        if (run && ctx.jobs.get(run.jobId)?.state === "running")
          throw conflict(`A match of ${from} with ${view.toName} is under way: wait for it.`);
        const m = await matchDone(ctx.root, { view, facts });
        if (m.state === "handoff" || m.state === "idle")
          throw conflict(m.error ?? `No answer is written yet for ${from} and ${view.toName}.`);
        if (m.decided?.batch) {
          ctx.events.publish({ type: "file.changed", path: `facts/${from}.corrections.jsonl` });
          ctx.events.publish({ type: "file.changed", path: "decisions/" });
        }
        return { status: 200, body: m };
      })
      .add("POST", "/api/links/match", async ({ body }) => {
        const b = Api.MatchLinksRequest.safeParse(body ?? {});
        if (!b.success)
          throw badRequest("Say both boxes: { from: <repo>, to: { repo } | { system } }.");
        const { from, to } = b.data;
        const { view, facts } = await candidatesOf(ctx.root, from, to);
        if (!view.calls.some((c) => c.status !== "paired"))
          throw conflict(`${from} has no loose call to match with ${view.toName}.`);
        if (!view.apis.length)
          throw conflict(
            `${view.toName} has no API on record${view.noApis ? `: ${view.noApis.command}` : ""}.`,
          );
        const key = keyOf(from, to);
        // The runtime is read before the busy checks, so check and start happen in one tick.
        const op = await loadOrgPack(orgPackDirOf(ctx.root));
        const had = running.get(key);
        if (had && ctx.jobs.get(had.jobId)?.state === "running")
          throw conflict(`A match of ${from} with ${view.toName} is under way: wait for it.`);
        const busy = ctx.jobs.runningOf("step");
        if (busy?.state === "running")
          throw conflict(
            `An AI step is running on this server (${busy.id}): wait for it to finish.`,
          );
        if (!copilotAcpAllowed(op) && !deps.runner) {
          // The brief for Copilot Chat; nothing runs here.
          const m = await runMatch(ctx.root, { view, quotes: quotesOf(facts), mode: "hand-off" });
          return { status: 202, body: m };
        }
        let done: Api.MatchLinksViewT;
        const job = ctx.jobs.start(
          "step",
          async (c) => {
            c.progress(0, 1, `Matching ${from} with ${view.toName}`);
            const signal = currentSignal();
            try {
              done = await runMatch(ctx.root, {
                view,
                quotes: quotesOf(facts),
                facts,
                mode: "copilot-acp",
                ...(deps.runner ? { runner: deps.runner } : {}),
                ...(signal ? { signal } : {}),
                onProgress: (line) => {
                  c.progress(0, 1, line.slice(0, 200));
                  // ADR 0187: every line, in the job's Console entry.
                  c.line(line);
                },
              });
            } catch (e) {
              // The brief couldn't be written or the answer read: said as failed, not left as a hand-off.
              const msg = e instanceof Error ? e.message : String(e);
              const me = running.get(key);
              if (me) me.error = msg;
              return { errors: [msg] };
            }
            const me = running.get(key);
            if (me && done.error) me.error = done.error;
            // The page follows the job's done event (ADR 0015) and reads the match again.
            return done.state === "failed"
              ? { errors: [done.error ?? "The session ended without an answer."] }
              : { result: { state: done.state } };
          },
          { title: `Match ${from} with ${view.toName}` },
        );
        running.set(key, { jobId: job.id }); // a new run drops the last run's error
        const files = await readMatch(ctx.root, view);
        return {
          status: 202,
          body: {
            ...files,
            state: "running",
            jobId: job.id,
            proposals: [],
            none: [],
            rejected: [],
          } satisfies Api.MatchLinksViewT,
        };
      })
  );
}
