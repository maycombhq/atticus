import {
  CALL_SECURITY_CHECK,
  callSecurityParams,
  checkCallSecurity,
  listQuestions,
  raiseQuestions,
  retireQuestion,
  TERM_STEP,
  termOfQuestion,
  termQuestionDrafts,
  type CallSecurityResult,
  type FactsJoinResult,
  type JoinRepo,
  type OrgPack,
  type Question,
  type TermsResult,
} from "@maycombhq/core";
import { estateRepos } from "@maycombhq/scanner";
import { repoTypeOf } from "./org-notes.js";

/**
 * What `atticus verify <repo> --write` says about the organisation's terms (ADR 0163): the
 * access lists against the calls, the possible links a shared value suggests, the question each
 * unknown term becomes, and what the accepted `call-security` rules find. Lines, and the
 * questions raised; the catalog's access grants are written with the rest of the catalog.
 */
export async function termsWrite(
  root: string,
  repo: string,
  o: {
    op: OrgPack;
    terms: TermsResult | undefined;
    repos: readonly JoinRepo[];
    join: FactsJoinResult | undefined;
    command: string;
    rerun: string;
    at: string;
    /** Each repo's checkout, for the repo type its fingerprint matches. */
    dirOf: (repo: string) => Promise<string | undefined>;
  },
): Promise<{ lines: string[]; raised: Question[] }> {
  const lines: string[] = [];
  const raised: Question[] = [];
  const t = o.terms;
  if (t) {
    for (const a of t.access) {
      const mine =
        a.repo === repo || (a.reason === "caller-not-listed" ? a.call.repo : a.owner.repo) === repo;
      if (!mine) continue;
      lines.push(
        a.reason === "caller-not-listed"
          ? `Access: ${a.message}. Add it to the list, or say why it calls (a finding for ${ownerOf(o.op, a.call.repo)}).`
          : `Access (a note): ${a.message}.`,
      );
    }
    for (const p of t.possible) {
      if (!p.seen.some((s) => s.repo === repo)) continue;
      lines.push(
        `Possible link (a guess, ${p.flag}): ${p.value} is written in ${[...new Set(p.seen.map((s) => `${s.repo} (${s.at})`))].join(", ")}; a note on the repo type saying what it means links them.`,
      );
    }

    // One question per term, file and repo type; a question asked another way now retires.
    const types = new Map<string, string | undefined>();
    for (const r of new Set(t.terms.map((x) => x.repo)))
      types.set(r, (await repoTypeOf(o.op, r, await o.dirOf(r)))?.id);
    const all = termQuestionDrafts(t, (r) => types.get(r));
    const drafts = all.filter((d) => d.terms.some((x) => x.repo === repo));
    const asked = new Map<string, string>();
    for (const d of drafts) {
      const r = await raiseQuestions(root, [d.draft], {
        step: TERM_STEP,
        repo: d.repo,
        command: o.command,
        rerun: o.rerun,
        at: o.at,
      });
      const q0 = r.of[0];
      if (q0) asked.set(`${d.repo}\u0000${d.term}\u0000${d.file}`, q0.id);
      for (const q of r.raised) {
        raised.push(q);
        lines.push(
          `A term nothing says the meaning of: asked ${q.id}: ${q.question} Answer it: atticus questions answer ${q.id} --option <n>${d.repoType ? `, and save the answer as a note on ${d.repoType} with atticus repo-type note ${d.repoType} --add "..."` : ""}; then ${o.rerun}.`,
        );
      }
    }
    // An open term question this repo is in that the facts no longer ask, or ask in other words
    // (another repo of the type joined the group), retires, naming the one that asks it now.
    for (const q of (await listQuestions(root, { step: TERM_STEP })).questions) {
      if (q.state !== "open") continue;
      const about = termOfQuestion(q.question);
      if (!about) continue;
      const k = `${q.repo}\u0000${about.term}\u0000${about.file}`;
      const now = asked.get(k);
      if (now === q.id) continue;
      const inGroup = all.find(
        (d) => d.repo === q.repo && d.term === about.term && d.file === about.file,
      );
      if (q.repo !== repo && !(inGroup && inGroup.terms.some((x) => x.repo === repo))) continue;
      const why = now
        ? "the same term is asked across a changed set of repos"
        : "the facts now give every value it asked about a role";
      await retireQuestion(root, q.id, { why, at: o.at, ...(now ? { replacedBy: [now] } : {}) });
      lines.push(`Retired ${q.id}: ${why}.`);
    }
  }

  // The accepted rules drafted from notes: checked on the facts, never on the note.
  if (o.join)
    for (const pack of o.op.checklists)
      for (const rule of pack.rules) {
        if (rule.status !== "active") continue;
        if (rule.check.type !== "deterministic" || rule.check.check !== CALL_SECURITY_CHECK)
          continue;
        const params = callSecurityParams(rule.check.params);
        if ("problem" in params) {
          lines.push(`Rule ${rule.id} (${pack.name}) can't be checked: ${params.problem}.`);
          continue;
        }
        for (const r of checkCallSecurity(params, { repos: o.repos, join: o.join }))
          if (r.call.repo === repo || r.chain.some((c) => c.repo === repo))
            lines.push(ruleLine(rule.id, r, o.op));
      }
  return { lines, raised };
}

function ownerOf(op: OrgPack, repo: string): string {
  const owner = (estateRepos(op).find((r) => r.id === repo) as { owner?: string } | undefined)
    ?.owner;
  return owner ? `${repo}'s owner, ${owner}` : `${repo}'s owner`;
}

function ruleLine(rule: string, r: CallSecurityResult, op: OrgPack): string {
  switch (r.outcome) {
    case "pass":
      return `Rule ${rule}: passes, ${r.message}.`;
    case "declared":
      return `Rule ${rule}: declared, ${r.message}.`;
    case "finding":
      return `Rule ${rule}: a finding for ${ownerOf(op, r.call.repo)}: ${r.message}.`;
  }
}
