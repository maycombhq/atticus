import {
  InitiativeError,
  initiativeStatus as statusOf,
  JOURNEYS,
  newInitiative,
  planJourney,
  recordCommitment,
  requestFromTeam as sendRequest,
} from "@maycombhq/initiatives";
import type { Output } from "./commands.js";
import { table } from "./table.js";

/**
 * atticus initiative …: initiatives and guided journeys (changes across teams and vendors
 * toward one outcome). Records go to catalog/curated; plans and system cards to
 * initiatives/<id>/. Exit 0 ok, 1 problems (a slipped or at-risk initiative, a missing record),
 * 2 usage.
 */

/** Things tests inject. */
export interface InitiativeDeps {
  now?: Date;
}

function fail(io: Output, e: unknown): number {
  if (e instanceof InitiativeError) {
    io.err(e.message);
    return e.code === "usage" ? 2 : 1;
  }
  throw e;
}

/** atticus initiative new "<title>" --journey <journey> [--by <you>] [--id id] [--release YYYY-MM-DD] [--epic id] */
export async function initiativeNew(
  root: string,
  o: {
    title?: string;
    journey?: string;
    by?: string;
    id?: string;
    release?: string;
    epic?: string;
    json?: boolean;
  },
  io: Output,
): Promise<number> {
  if (!o.title || !o.journey || !o.by) {
    io.err(
      `Usage: atticus initiative new "<title>" --journey <${JOURNEYS.join("|")}> [--by <you>] [--release YYYY-MM-DD]`,
    );
    return 2;
  }
  try {
    const r = await newInitiative(root, {
      title: o.title,
      journey: o.journey,
      by: o.by,
      ...(o.id ? { id: o.id } : {}),
      ...(o.release ? { targetRelease: o.release } : {}),
      ...(o.epic ? { adoEpic: o.epic } : {}),
    });
    if (o.json) {
      io.out(JSON.stringify(r, null, 2));
      return 0;
    }
    io.out(`Started ${r.initiative.id} (${r.initiative.journey}). Wrote ${r.written}.`);
    io.out(
      `Plan it: atticus initiative plan ${r.initiative.id} --target <system>${o.release ? "" : " --release YYYY-MM-DD"}`,
    );
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus initiative plan <id> --target <system> [--release YYYY-MM-DD] [--system s]... [--by <you>] [--dry-run] [--json] */
export async function initiativePlan(
  root: string,
  id: string | undefined,
  o: {
    target?: string;
    release?: string;
    systems?: string[];
    by?: string;
    dryRun?: boolean;
    json?: boolean;
  },
  io: Output,
  deps: InitiativeDeps = {},
): Promise<number> {
  if (!id || !o.by) {
    io.err(
      "Usage: atticus initiative plan <id> --target <system> [--release YYYY-MM-DD] [--by <you>] [--dry-run]",
    );
    return 2;
  }
  try {
    const r = await planJourney(root, id, {
      by: o.by,
      ...(o.target ? { target: o.target } : {}),
      ...(o.release ? { targetRelease: o.release } : {}),
      ...(o.systems?.length ? { systems: o.systems } : {}),
      ...(o.dryRun ? { dryRun: true } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    if (o.json) {
      io.out(JSON.stringify(r, null, 2));
      return 0;
    }
    io.out(
      `${r.initiative.title}: ${r.plan.items.length} items from ${r.plan.target} back to ${r.plan.targetRelease} (${r.plan.journey} journey, ${r.plan.journeySource}).`,
    );
    for (const l of table(
      ["ITEM", "KIND", "WITH", "START", "DUE", "DAYS", "LEAD TIME FROM"],
      r.plan.items.map((i) => [
        i.key,
        i.kind,
        i.party ?? i.change ?? i.owner ?? "",
        i.start,
        i.due,
        String(i.days),
        i.leadTime,
      ]),
    ))
      io.out(l);
    if (r.changes.length) {
      io.out("Changes to start:");
      for (const c of r.changes) io.out(`  ${c.command}`);
    }
    for (const n of r.notes) io.out(`Note: ${n}`);
    io.out(
      o.dryRun
        ? "Dry run: nothing written."
        : `Wrote ${r.written.length} files (the plan and ${r.commitments.length} commitments).`,
    );
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus initiative status <id> [--json]: critical path, slipped and at-risk commitments. */
export async function initiativeStatus(
  root: string,
  id: string | undefined,
  o: { json?: boolean },
  io: Output,
  deps: InitiativeDeps = {},
): Promise<number> {
  if (!id) {
    io.err("Usage: atticus initiative status <id> [--json]");
    return 2;
  }
  try {
    const s = await statusOf(root, id, deps.now ? { now: deps.now } : {});
    const bad = s.status === "at-risk" || s.status === "slipped";
    if (o.json) {
      io.out(JSON.stringify(s, null, 2));
      return bad ? 1 : 0;
    }
    io.out(
      `${s.title} (${s.journey}): ${s.status}${s.targetRelease ? `; target ${s.targetRelease}` : ""}${s.projectedRelease ? `, projected ${s.projectedRelease}` : ""}.`,
    );
    if (s.criticalPath.length) io.out(`Critical path: ${s.criticalPath.join(" → ")}`);
    if (s.items.length)
      for (const l of table(
        ["ITEM", "STATUS", "DUE", "PROJECTED", "FLOAT", "WHY"],
        s.items.map((i) => [i.key, i.status, i.due, i.projectedFinish, String(i.float), i.why]),
      ))
        io.out(l);
    const open = s.commitments.filter((c) => c.status === "slipped" || c.status === "at-risk");
    if (open.length) {
      io.out("Commitments slipped or at risk:");
      for (const c of open)
        io.out(`  ${c.id} (${c.party}, needed by ${c.neededBy}): ${c.status}. ${c.why}`);
    }
    for (const n of s.notes) io.out(`Note: ${n}`);
    return bad ? 1 : 0;
  } catch (e) {
    return fail(io, e);
  }
}

/**
 * atticus initiative request <id> <party> [--by <you>] [--system s]...: send a team or vendor a
 * one-page system card; the reply goes into intake and is tracked as a commitment, and the
 * message is a manual step (atticus todo) a person sends.
 */
export async function requestFromTeam(
  root: string,
  initiativeId: string | undefined,
  partyId: string | undefined,
  o: { by?: string; systems?: string[]; json?: boolean },
  io: Output,
  deps: InitiativeDeps = {},
): Promise<number> {
  if (!initiativeId || !partyId || !o.by) {
    io.err("Usage: atticus initiative request <id> <party> [--by <you>] [--system s]...");
    return 2;
  }
  try {
    const r = await sendRequest(root, initiativeId, partyId, {
      by: o.by,
      ...(o.systems?.length ? { systems: o.systems } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    if (o.json) {
      io.out(JSON.stringify({ ...r, card: undefined }, null, 2));
      return 0;
    }
    io.out(`Wrote the system card ${r.cardPath}.`);
    io.out(`Tracked as ${r.commitment.id}: reply needed by ${r.commitment.neededBy}.`);
    io.out(`Send it: atticus todo show ${r.step.id} (then atticus todo done ${r.step.id}).`);
    io.out("When the reply comes, add it with atticus intake add <file>.");
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus initiative commit <commitment> <open|at-risk|done|slipped> [--by <you>]: record a commitment's status. */
export async function initiativeCommitment(
  root: string,
  id: string | undefined,
  status: string | undefined,
  o: { by?: string },
  io: Output,
): Promise<number> {
  const states = ["open", "at-risk", "done", "slipped"];
  if (!id || !status || !o.by || !states.includes(status)) {
    io.err(`Usage: atticus initiative commit <commitment> <${states.join("|")}> [--by <you>]`);
    return 2;
  }
  try {
    const r = await recordCommitment(root, id, { status: status as never, by: o.by });
    io.out(`${r.commitment.id} is ${status}. Wrote ${r.written}.`);
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}
