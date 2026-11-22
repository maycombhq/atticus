import { changeStore } from "@maycombhq/changes";
import { loadOrgPack, orgPackDirOf, quickPathOf, type Api } from "@maycombhq/core";
import { conformanceOf, conformChange, ConformError } from "@maycombhq/taskrun";
import type { Output } from "./commands.js";

/**
 * atticus change conform <change> [--repo r] [--ref branch] [--task t] [--latest] [--json]
 * (ADR 0114): does the code do what the design says? Scans each repo's branch at its commit
 * (the change branch, a task's branch, or --ref) from the base clone, compares the records with
 * the target flows, keeps the result and writes the findings on the conform gate. --latest
 * shows the stored result and scans nothing (the MCP tool uses it). No AI, no network.
 *
 * ADR 0206: and the claims the change states (each operation in each of its repos, each row of a
 * quick change's design.md In the code), each with its outcome, its cite and what to do next.
 *
 * Exit 0 nothing missing, still there, unexpected, different or to check by hand (or --latest),
 * 1 something is, or there is nothing to check yet, 2 no such change, task or base clone.
 */

const CITE = (c: Api.ConformItemT["at"][number]) =>
  `${c.repo ? `${c.repo}:` : ""}${c.path}${c.line ? `:${c.line}` : ""}`;

const LABEL: Record<Api.ConformItemT["status"], string> = {
  found: "found",
  missing: "MISSING",
  "still-there": "STILL THERE",
  unexpected: "NOT IN THE DESIGN",
};

const CLAIM: Record<Api.ConformClaimT["outcome"], string> = {
  present: "PRESENT",
  "present-differently": "PRESENT DIFFERENTLY",
  missing: "MISSING",
  "not-checkable": "NOT CHECKABLE",
  unconfirmed: "COULDN'T CONFIRM",
};

/** The claims' outcomes in words: `2 present, 1 missing`. */
export function claimCountWords(
  n: NonNullable<Api.ConformRepoResultT["counts"]["claims"]>,
): string {
  return [
    `${n.present} present`,
    `${n.differs} present differently`,
    `${n.missing} missing`,
    `${n.notCheckable} to check by hand`,
    `${n.unconfirmed} not confirmed`,
  ].join(", ");
}

function printClaims(r: Api.ConformRepoResultT, io: Output): void {
  if (!r.claims?.length) return;
  io.out(`  Claims: ${claimCountWords(r.counts.claims!)}.`);
  for (const file of [...new Set(r.claims.map((c) => c.from.file))]) {
    io.out(`  Stated in ${file}:`);
    for (const c of r.claims.filter((x) => x.from.file === file)) {
      const state = c.finding && c.finding.state !== "open" ? ` (${c.finding.state})` : "";
      io.out(`  ${CLAIM[c.outcome]}  ${c.what}  ${c.at.map(CITE).join(", ")}${state}`);
      if (c.why) io.out(`    ${c.why}`);
      if (c.outcome !== "present") io.out(`    Next: ${c.next}`);
    }
  }
}

function print(results: Api.ConformRepoResultT[], io: Output): void {
  for (const r of results) {
    const n = r.counts;
    // ADR 0206: a repo only claims name, with no clone here: its claims, and why nothing was scanned.
    if (!r.commit) {
      io.out(`${r.repo}: not scanned here.`);
      printClaims(r, io);
      for (const p of r.problems) io.err(`${r.repo}: ${p}`);
      continue;
    }
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
    printClaims(r, io);
    for (const p of r.problems) io.err(`${r.repo}: ${p}`);
  }
}

/**
 * ADR 0206: a change with nothing to check yet, flows or claims. The review: a quick change is
 * offered the quick path's next step, never a stage (ADR 0201).
 */
const nothingYet = (change: string, quick: boolean) =>
  quick
    ? `${change} is a quick change and its design.md doesn't say what the code will have yet, so there is nothing to check the code against: the spec writer writes its ## In the code (/define-change ${change}), or a person does; atticus change status ${change} says whether it reads. Then check again: atticus change conform ${change}.`
    : `${change} has no target flows and states no claims yet, so there is nothing to check the code against: the architecture stage writes target flows and operations (atticus change architecture ${change}); a quick change's design.md says what the code will have under ## In the code.`;

/** Whether the change takes the quick path (`quickPathOf` its type). */
async function quickChange(root: string, change: string): Promise<boolean> {
  const c = await changeStore(root)
    .read(change)
    .catch(() => undefined);
  const op = c ? await loadOrgPack(orgPackDirOf(root)).catch(() => undefined) : undefined;
  const type = op?.changeTypes.types.find((t) => t.id === c?.type);
  return !!type && quickPathOf(type);
}

/**
 * What a check that ran found to act on: the flows' items and the claims that make a finding,
 * whose finding is still open (the review of ADR 0206: a waived or dismissed one is acted on).
 */
const open = (x: { finding?: { state: string } }) => (x.finding?.state ?? "open") === "open";
const toActOn = (r: Api.ConformRepoResultT) =>
  r.items.filter((i) => i.status !== "found" && open(i)).length +
  (r.claims ?? []).filter(
    (c) =>
      (c.outcome === "missing" ||
        c.outcome === "present-differently" ||
        c.outcome === "not-checkable") &&
      open(c),
  ).length;

/**
 * The last line of a check that raised nothing to act on (the persona check of beta.30, and its
 * review): the code has everything only when every claim is present and every item found; else
 * what couldn't be confirmed or is left, counted; what a person waived or dismissed is said as
 * settled. An item a person dismissed that isn't in the design is nothing the change states.
 */
export function conformSummary(
  results: readonly Api.ConformRepoResultT[],
  run: { flows: number; claims?: number },
): string {
  const claims = results.flatMap((r) => r.claims ?? []);
  const items = results.flatMap((r) => r.items);
  const unconfirmed = claims.filter((c) => c.outcome === "unconfirmed").length;
  const unsure = (c: (typeof claims)[number]) =>
    c.outcome !== "present" && c.outcome !== "unconfirmed";
  const left =
    claims.filter((c) => unsure(c) && open(c)).length +
    items.filter((i) => i.status !== "found" && open(i)).length;
  const settledClaims = claims.filter((c) => unsure(c) && !open(c)).length;
  const settledItems = items.filter(
    (i) => i.status !== "found" && i.status !== "unexpected" && !open(i),
  ).length;
  const settled = settledClaims + settledItems;
  if (unconfirmed || left) {
    const parts = [
      unconfirmed ? `${unconfirmed} couldn't be confirmed` : "",
      left ? `${left} missing, different or to check by hand` : "",
      settled ? `${settled} waived or dismissed` : "",
    ].filter(Boolean);
    return `Not everything the change states is confirmed in the code: ${parts.join(", ")}. Each claim above says what to do next; check again once it is done.`;
  }
  if (settled) {
    const n = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
    const what = [
      settledClaims ? n(settledClaims, "claim") : "",
      settledItems ? n(settledItems, "item") : "",
    ]
      .filter(Boolean)
      .join(" and ");
    return `The code has everything else the change states it will have; ${what} ${settled === 1 ? "was" : "were"} waived or dismissed by a person.`;
  }
  return run.flows
    ? `The code has everything its target flows add, and nothing they don't name${run.claims ? ", and everything the change states it will have" : ""}.`
    : "The code has everything the change states it will have, and nothing its design doesn't name.";
}

export async function changeConformCommand(
  root: string,
  change: string,
  o: {
    repo?: string;
    ref?: string;
    task?: string;
    latest?: boolean;
    json?: boolean;
    /**
     * Eighth UX walk: the app's Check the code again. Findings are the check's answer, not a
     * failed step, so a check that ran exits 0 with them.
     */
    findingsAnswer?: boolean;
  },
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
        v.flows || v.claims
          ? `${change} hasn't been checked against its design yet: atticus change conform ${change}.`
          : nothingYet(change, await quickChange(root, change)),
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
    // The results with their findings' states, as the gate now holds them.
    const view = await conformanceOf(root, change);
    const results = run.results.map(
      (r) => view?.results.find((v) => v.repo === r.repo && v.checkedAt === r.checkedAt) ?? r,
    );
    const bad = results.some((r) => toActOn(r) > 0);
    if (o.json) {
      io.out(JSON.stringify(view, null, 2));
      return run.results.length && !bad ? 0 : 1;
    }
    for (const p of run.problems) io.err(p);
    if (!run.flows && !run.claims) {
      io.err(nothingYet(change, await quickChange(root, change)));
      return 1;
    }
    if (!run.results.length) return 1;
    print(results, io);
    // The persona check of beta.30: success is said only when every claim is present and every
    // item found (conformSummary).
    io.out(
      bad
        ? `The findings are on the conform gate${run.round ? ` (round ${run.round})` : ""}: atticus findings ${change} lists them; dismiss one with atticus finding ${change} <id> not-relevant --reason "...".`
        : conformSummary(results, run),
    );
    return bad && !o.findingsAnswer ? 1 : 0;
  } catch (e) {
    if (e instanceof ConformError) {
      io.err(e.message);
      return 2;
    }
    throw e;
  }
}
