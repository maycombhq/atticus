import type { Api } from "@maycombhq/core";
import { conformanceOf, conformChange, ConformError } from "@maycombhq/taskrun";
import type { Output } from "./commands.js";

/**
 * atticus change conform <change> [--repo r] [--ref branch] [--task t] [--latest] [--json]
 * (ADR 0114): does the code do what the design says? Scans each repo's branch at its commit
 * (the change branch, a task's branch, or --ref) from the base clone, compares the records with
 * the target flows, keeps the result and writes the findings on the conform gate. --latest
 * shows the stored result and scans nothing (the MCP tool uses it). No AI, no network.
 *
 * Exit 0 nothing missing, still there or unexpected (or --latest), 1 something is, or there is
 * nothing to check yet, 2 no such change, task or base clone.
 */

const CITE = (c: Api.ConformItemT["at"][number]) =>
  `${c.repo ? `${c.repo}:` : ""}${c.path}${c.line ? `:${c.line}` : ""}`;

const LABEL: Record<Api.ConformItemT["status"], string> = {
  found: "found",
  missing: "MISSING",
  "still-there": "STILL THERE",
  unexpected: "NOT IN THE DESIGN",
};

function print(results: Api.ConformRepoResultT[], io: Output): void {
  for (const r of results) {
    const n = r.counts;
    io.out(
      `${r.repo} at ${r.ref} (${r.commit.slice(0, 12)}, from ${r.base.slice(0, 12)})${r.task ? `, task ${r.task}` : ""}: ${n.found} found, ${n.missing} missing, ${n.stillThere} still there, ${n.unexpected} not in the design.`,
    );
    for (const i of r.items)
      io.out(
        `  ${LABEL[i.status]}  ${i.what}  ${i.at.map(CITE).join(", ")}${i.finding && i.finding.state !== "open" ? ` (${i.finding.state})` : ""}`,
      );
    if (r.unchecked.length) {
      io.out("  Not checked by a scan (a person or a test checks these):");
      for (const u of r.unchecked)
        io.out(`    ${u.flow}${u.item ? ` item ${u.item}` : " trigger"} (${u.kind}): ${u.why}`);
    }
    for (const p of r.problems) io.err(`${r.repo}: ${p}`);
  }
}

export async function changeConformCommand(
  root: string,
  change: string,
  o: { repo?: string; ref?: string; task?: string; latest?: boolean; json?: boolean },
  io: Output,
): Promise<number> {
  if (o.latest) {
    const v = await conformanceOf(root, change);
    if (!v) {
      io.err(`There is no change ${change}.`);
      return 2;
    }
    if (o.json) {
      io.out(JSON.stringify(v, null, 2));
      return 0;
    }
    for (const p of v.problems) io.err(p);
    if (!v.results.length)
      io.out(
        v.flows
          ? `${change} hasn't been checked against its target flows yet: atticus change conform ${change}.`
          : `${change} has no target flows yet, so there is nothing to check the code against.`,
      );
    print(v.results, io);
    return 0;
  }
  try {
    const run = await conformChange(root, change, {
      ...(o.repo ? { repo: o.repo } : {}),
      ...(o.ref ? { ref: o.ref } : {}),
      ...(o.task ? { task: o.task } : {}),
    });
    const bad = run.results.some(
      (r) => r.counts.missing + r.counts.stillThere + r.counts.unexpected > 0,
    );
    if (o.json) {
      io.out(JSON.stringify(await conformanceOf(root, change), null, 2));
      return run.results.length && !bad ? 0 : 1;
    }
    for (const p of run.problems) io.err(p);
    if (!run.flows) {
      io.err(
        `${change} has no target flows yet, so there is nothing to check the code against: the architecture stage writes them (atticus change architecture ${change}).`,
      );
      return 1;
    }
    if (!run.results.length) return 1;
    print(run.results, io);
    io.out(
      bad
        ? `The findings are on the conform gate${run.round ? ` (round ${run.round})` : ""}: atticus findings ${change} lists them; dismiss one with atticus finding ${change} <id> not-relevant --reason "...".`
        : "The code has everything its target flows add, and nothing they don't name.",
    );
    return bad ? 1 : 0;
  } catch (e) {
    if (e instanceof ConformError) {
      io.err(e.message);
      return 2;
    }
    throw e;
  }
}
