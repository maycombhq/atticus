import type { Fact } from "@maycombhq/core";
import { readFactsSlot } from "@maycombhq/scanner";
import { factRefs, type VerifyReport } from "@maycombhq/verify";

/**
 * Beta.28.1 (field report 5): one rejected fact no longer blocks `verify <repo> --write`. The
 * kept facts (a person's corrections and pairings with them) are written and each rejected fact
 * is left out, said with the file to fix. A rejected fact never takes away what it backed: when
 * the repo's facts snapshot (its last accepted write) holds a fact of that id, that copy is
 * written again in its place, so the build removes nothing the rejection alone would remove;
 * a fact the snapshot doesn't hold backed nothing yet, and is simply not written.
 *
 * The review of beta.28.1: an earlier copy is written back only while every fact it names is
 * written too (until nothing changes). One that names a fact the person removed from the read,
 * or one left out without a copy, isn't: what it backed goes through the removal guard as any
 * removal does, and its line names the fact it lost, so the snapshot never names a missing fact.
 */
export interface LeftOutFact {
  id: string;
  code: string;
  message: string;
  /** The source file and line the fact cites: where to read again. */
  file: string;
  line: number;
  /** The snapshot's earlier accepted copy was written in its place (its records stay). */
  kept: boolean;
  /** The snapshot held an earlier copy (written back or, naming a fact gone, not). */
  had?: boolean;
  /**
   * The facts it names that aren't written (removed from the read, or left out too): the cause
   * to fix first, said in its line in place of its own source line.
   */
  lost?: { id: string; leftOut: boolean }[];
}

/** Exit code of a `verify --write` that wrote, with rejected facts left out (not a failure). */
export const APPLIED_WITH_LEFT_OUT = 3;

export async function leftOutOf(
  root: string,
  repo: string,
  report: Pick<VerifyReport, "accepted" | "rejected">,
): Promise<{ ok: true; facts: Fact[]; leftOut: LeftOutFact[] } | { ok: false; problem: string }> {
  const slot = await readFactsSlot(root, repo);
  // A snapshot that doesn't read can't say what a rejected fact backed: the write is refused.
  if (slot && !slot.ok)
    return {
      ok: false,
      problem: `${repo}'s facts snapshot ${slot.problem}, so what the rejected facts backed can't be kept`,
    };
  const before = new Map((slot?.ok ? slot.facts : []).map((f) => [f.id, f]));
  const kept = new Set(report.accepted.map((f) => f.id));
  const carried: Fact[] = [];
  const leftOut: LeftOutFact[] = [];
  const seen = new Set<string>();
  for (const r of report.rejected) {
    const id = r.fact.id;
    if (seen.has(id)) continue;
    seen.add(id);
    const was = kept.has(id) ? undefined : before.get(id);
    if (was) carried.push(was);
    leftOut.push({
      id,
      code: r.code,
      message: r.message,
      file: r.fact.cite.file,
      line: r.fact.cite.line,
      kept: was !== undefined,
      ...(was !== undefined ? { had: true } : {}),
    });
  }
  // Until nothing changes: a copy naming a fact not written isn't written either.
  const written = new Set([...report.accepted, ...carried].map((f) => f.id));
  let back = carried;
  for (;;) {
    const stay = back.filter((f) => factRefs(f).every((r) => written.has(r.id)));
    if (stay.length === back.length) break;
    for (const f of back) if (!stay.includes(f)) written.delete(f.id);
    back = stay;
  }
  const outIds = new Set(leftOut.map((l) => l.id));
  const byId = new Map(report.rejected.map((r) => [r.fact.id, r.fact] as const));
  for (const l of leftOut) {
    l.kept = written.has(l.id) && !kept.has(l.id);
    if (l.kept) continue;
    const named = factRefs(byId.get(l.id) ?? before.get(l.id)!).filter((r) => !written.has(r.id));
    if (named.length)
      l.lost = [
        ...new Map(named.map((r) => [r.id, { id: r.id, leftOut: outIds.has(r.id) }])).values(),
      ];
  }
  return { ok: true, facts: [...report.accepted, ...back], leftOut };
}

/** One fact's line among those `leftOutLines` says (the app counts them). */
export const LEFT_OUT_LINE = /^ {2}left out: /;

/** The lines a written `verify --write` says of the facts it left out, each with its file. */
export function leftOutLines(
  repo: string,
  leftOut: readonly LeftOutFact[],
  files: { facts: string; rejected: string },
  shown: number,
  /** Questions or reviewed lines refused beside them (written the same: the facts are). */
  alsoRefused = 0,
): string[] {
  const n = leftOut.length;
  const kept = leftOut.filter((l) => l.kept).length;
  const out = [
    `Applied to ${repo} with ${n} ${n === 1 ? "fact" : "facts"} left out (rejected; ${kept ? `${kept} kept as the last Apply wrote ${kept === 1 ? "it" : "them"}, so nothing ${kept === 1 ? "it backs is" : "they back is"} removed` : leftOut.some((l) => l.had && l.lost?.length) ? "none kept: a fact one names is gone, so what they back is removed with it" : "none was in the catalog before"}):`,
  ];
  for (const l of leftOut.slice(0, shown))
    out.push(
      l.lost?.length
        ? `  left out: ${l.id} (${l.code}): it names ${l.lost.map((x) => `${x.id}, which ${x.leftOut ? "is left out too" : "the read no longer has"}`).join("; and ")}: put ${l.lost.length === 1 ? "it" : "them"} back or drop ${l.id} in ${files.facts}`
        : `  left out: ${l.id} (${l.code}): fix it in ${files.facts}, reading ${l.file}:${l.line} again${l.kept ? " (its earlier copy stays in the catalog)" : ""}`,
    );
  if (n > shown) out.push(`  ... and ${n - shown} more (all in ${files.rejected})`);
  if (alsoRefused)
    out.push(
      `  ${alsoRefused} ${alsoRefused === 1 ? "question or reviewed line was" : "questions or reviewed lines were"} refused too (listed above, each with why in ${files.rejected}).`,
    );
  out.push(
    `Each one's reason is in ${files.rejected}. Fix them and run atticus verify ${repo} --write again to put them in.`,
  );
  return out;
}
