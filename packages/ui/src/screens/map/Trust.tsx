import { useState, type ReactNode } from "react";
import { RunWithCopilot } from "../../app/copilot-runs.js";
import { appStep, ReadRepo } from "../../app/app-step.js";
import type { Api } from "@maycombhq/core";
import { useApi, useReloadOnFiles, type Loaded } from "../../api/client.js";
import { Citation, EvidenceProvider } from "../../app/evidence.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { Command, Problems } from "../work/RunNext.js";
import "../work/work.css";
import { AuditAnswer } from "./AuditAnswer.js";
import { AnswerBoxes } from "./AnswerBoxes.js";
import { DropFact } from "./drop-fact.js";
import { mismatchesHash } from "../../app/contracts.js";
import { DecidePaused, useDecisions } from "../../app/decisions.js";

/**
 * Map › Trust (ADR 0124): how far to trust each repo's map, from the files the verifier writes.
 * Per repo: the facts it kept and rejected, how much of the code they cover and the files not
 * read yet, the facts' commit against the checkout's, whether the catalog is built from the
 * facts or the built-in readers, and the command to run next. It reads files only
 * (`GET /api/trust`); the app runs nothing. Above them, the estate's freshness (ADR 0141, P5):
 * which clones have moved past their facts' commit and what reading each again costs, from
 * `GET /api/trust/fresh`, which runs read-only local git and writes nothing.
 */

const T = COPY.trust;
const R = COPY.runNext;

type Repo = Api.TrustRepoT;

/** ADR 0149: the Sample audit's Answer a sample, opened in place. */
function AnswerToggle({ repo }: { repo: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        className="btn"
        aria-expanded={open}
        aria-label={T.sample.openOf(repo)}
        onClick={() => setOpen((o) => !o)}
      >
        {T.sample.open}
      </button>
      {open && <AuditAnswer repo={repo} />}
    </div>
  );
}

/** Why a repo is in its state, in words. */
export function trustWhy(r: Repo): string {
  const report = r.verify.report;
  switch (r.state) {
    case "not-read":
      return T.why.notRead;
    case "unverified":
      return T.why.unverified;
    case "rejected":
      return T.why.rejected(report?.rejected ?? 0);
    case "stale":
      return T.why.stale(report?.commit ?? r.facts.commit ?? "", r.checkout.commit ?? "");
    case "unwritten":
      return T.why.unwritten;
    case "unknown-files":
      return T.why.unknownFiles(report?.coverage.unknown ?? 0, r.repo);
    default:
      return T.why.trusted;
  }
}

/** The facts' commit against the checkout's, in words. */
export function commitWords(r: Repo): string {
  const facts = r.verify.report?.commit ?? r.facts.commit;
  if (!facts) return T.noFactsCommit;
  if (!r.checkout.commit) return T.noCheckout(facts);
  return r.sameCommit ? T.sameCommit(facts) : T.otherCommit(facts, r.checkout.commit);
}

/** The chip a trust state wears (also on Home). */
export const trustChip = (s: Repo["state"]) =>
  s === "trusted" ? "done" : s === "rejected" || s === "stale" ? "blocking" : "warn";

/**
 * A count that opens what it counts (ADR 0135, C3): a disclosure whose summary is the count, its
 * list and the action that closes each item inside. Zero says so and opens nothing.
 */
export function CountList(p: { n: number; what: string; children: (open: boolean) => ReactNode }) {
  const [open, setOpen] = useState(false);
  if (p.n === 0) return <>{T.none}</>;
  return (
    <details className="trust-list" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{T.show(p.n, p.what)}</summary>
      {p.children(open)}
    </details>
  );
}

const placeOf = (file?: string, line?: number) =>
  file ? (line ? `${file}:${line}` : file) : undefined;

const SHOWN = 50;

/** The repo's kept facts, read when the count is opened (GET /api/facts/{repo}), each cited. */
export function RepoFactsList(p: {
  repo: string;
  of: Loaded<Api.RepoFactsViewT>;
  only?: (f: Api.FactCiteViewT) => boolean;
}) {
  return (
    <View
      of={p.of}
      empty={(v) => !(p.only ? v.facts.filter(p.only) : v.facts).length}
      emptyText={T.none}
    >
      {(v) => {
        const all = p.only ? v.facts.filter(p.only) : v.facts;
        return (
          <>
            <ul className="mono trust-items">
              {all.slice(0, SHOWN).map((f) => (
                <li key={f.id}>
                  <Citation repo={p.repo} at={`${f.cite.file}:${f.cite.line}`} /> {f.label}
                </li>
              ))}
            </ul>
            {all.length > SHOWN && (
              <p className="work-say">{T.moreFacts(all.length - SHOWN, v.file)}</p>
            )}
          </>
        );
      }}
    </View>
  );
}

function LoadFacts(p: { repo: string; only?: (f: Api.FactCiteViewT) => boolean }) {
  const of = useApi<Api.RepoFactsViewT>(`/api/facts/${encodeURIComponent(p.repo)}`);
  return <RepoFactsList repo={p.repo} of={of} {...(p.only ? { only: p.only } : {})} />;
}

const redactedQuote = (f: Api.FactCiteViewT) => !!f.cite.quote?.includes("<redacted>");

export function TrustRow({ r }: { r: Repo }) {
  const report = r.verify.report;
  const head = `trust-${r.repo}`;
  const lists = r.lists;
  const rejectedFile = r.verify.path.replace(/\.verify\.yaml$/, ".rejected.jsonl");
  return (
    <article className="list-row" style={{ display: "block" }} aria-labelledby={head}>
      <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
        <h3 id={head} className="h" style={{ fontSize: 14, margin: 0 }}>
          {r.repo}
        </h3>
        <span className="row" style={{ gap: 8 }}>
          <RunWithCopilot
            ask={{ kind: "repos", repos: [r.repo], force: true }}
            label={COPY.copilotRuns.start.again(r.repo)}
          />
          <span className={`chip ${trustChip(r.state)}`}>{T.states[r.state]}</span>
        </span>
      </div>
      <p className="work-why" style={{ margin: "6px 0" }}>
        {trustWhy(r)}
      </p>
      {report?.secrets?.length ? (
        <div role="alert" className="stack" style={{ gap: 4, margin: "6px 0" }}>
          <p style={{ margin: 0 }}>
            <span className="chip warn">
              <span aria-hidden="true">⚠ </span>
              {T.secrets.title(report.secrets.length)}
            </span>
          </p>
          <ul className="ev-list" style={{ margin: "4px 0" }}>
            {report.secrets.map((x) => (
              <li key={`${x.file}:${x.line}`}>
                <code className="mono">
                  {T.secrets.at(x.file, x.line, x.key || T.secrets.secretKey)}
                </code>
              </li>
            ))}
          </ul>
          <p className="work-say" style={{ margin: 0 }}>
            {T.secrets.fix}
          </p>
        </div>
      ) : null}
      <dl className="run-facts" style={{ margin: "8px 0" }}>
        <dt>{T.kept}</dt>
        <dd>
          {report ? report.accepted : T.noReport}
          {report && report.redacted > 0 ? ` (${T.redacted(report.redacted)})` : ""}
          {report && r.facts.present && (
            <CountList n={report.accepted} what={T.what.kept!}>
              {(open) => (
                <>
                  <p className="work-say">{T.keptFix}</p>
                  {open && <LoadFacts repo={r.repo} />}
                </>
              )}
            </CountList>
          )}
          {report && report.redacted > 0 && r.facts.present && (
            <CountList n={report.redacted} what={T.what.redacted!}>
              {(open) => (
                <>
                  <p className="work-say">{T.redactedFix}</p>
                  {open && <LoadFacts repo={r.repo} only={redactedQuote} />}
                </>
              )}
            </CountList>
          )}
        </dd>
        <dt>{T.rejected}</dt>
        <dd>
          {report ? report.rejected : T.noReport}
          {lists && lists.rejected.length > 0 && (
            <CountList n={lists.rejected.length} what={T.what.rejected!}>
              {() => (
                <>
                  <ul className="trust-items">
                    {lists.rejected.map((x, i) => (
                      <li key={`${x.fact ?? x.code}-${i}`}>
                        <code className="mono">{placeOf(x.file, x.line) ?? T.rejectedNoLine}</code>
                        {x.fact && <span className="mono"> {x.fact}</span>}
                        {" · "}
                        {T.rejectedLine(x.code, x.message)}
                        {/* App-only audit: a person may drop a rejected fact, with why. */}
                        {x.fact && <DropFact repo={r.repo} fact={x.fact} />}
                      </li>
                    ))}
                  </ul>
                  <p className="work-say">{T.rejectedFix(rejectedFile)}</p>
                  {/* ADR 0188: read it again from here, then Apply checks the facts again. */}
                  <ReadRepo repo={r.repo} again />
                  <Command text={`/atticus-map ${r.repo}`} label={R.copySlash} />
                  <Command text={`atticus verify ${r.repo}`} label={R.copy} />
                </>
              )}
            </CountList>
          )}
        </dd>
        <dt>{T.coverage}</dt>
        <dd>
          {report
            ? T.coverageOf(
                report.coverage.ratio,
                report.coverage.read,
                report.coverage.unknown,
                report.coverage.excluded,
              )
            : T.noReport}
          {report && report.coverage.unknown > 0 && (
            <CountList n={report.coverage.unknown} what={T.what.unknown!}>
              {() => (
                <>
                  <ul className="mono trust-items">
                    {report.unknownFiles.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                  {report.coverage.unknown > report.unknownFiles.length && (
                    <p className="work-say">
                      {T.more(report.coverage.unknown - report.unknownFiles.length, r.verify.path)}
                    </p>
                  )}
                  <p className="work-say">{T.unknownFix(r.repo)}</p>
                  <ReadRepo repo={r.repo} again />
                  <Command text={`/atticus-map ${r.repo}`} label={R.copySlash} />
                </>
              )}
            </CountList>
          )}
          {report && report.coverage.excluded > 0 && (
            <CountList n={report.coverage.excluded} what={T.what.excluded!}>
              {() => (
                <>
                  <ul className="mono trust-items">
                    {(lists?.excluded ?? []).map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                  {report.coverage.excluded > (lists?.excluded.length ?? 0) && (
                    <p className="work-say">
                      {T.more(
                        report.coverage.excluded - (lists?.excluded.length ?? 0),
                        r.verify.path,
                      )}
                    </p>
                  )}
                  <p className="work-say">{T.excludedFix(r.repo)}</p>
                </>
              )}
            </CountList>
          )}
        </dd>
        {lists && (
          <>
            <dt>{T.asked}</dt>
            <dd>
              {lists.asked.length}
              <CountList n={lists.asked.length} what={T.what.asked!}>
                {() => (
                  <>
                    <p className="work-say">{T.askedFix}</p>
                    <ul className="trust-items">
                      {lists.asked.map((q) => (
                        <li key={q.id}>
                          {q.question}{" "}
                          {q.lines.map((l) => (
                            <code key={l} className="mono">
                              {l}{" "}
                            </code>
                          ))}
                          <a href={`#/questions/${q.id}`}>{T.answer}</a>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </CountList>
            </dd>
          </>
        )}
        {r.facts.unverified > 0 && (
          <>
            <dt>{T.unverified}</dt>
            <dd>
              {r.facts.unverified}
              <CountList n={r.facts.unverified} what={T.what.unverified!}>
                {() => (
                  <>
                    <p className="work-say">{T.unverifiedFix}</p>
                    <ul className="mono trust-items">
                      {(lists?.unverified ?? []).map((f) => (
                        <li key={f.fact}>
                          {f.file}:{f.line} {f.fact}
                        </li>
                      ))}
                    </ul>
                    {r.facts.unverified > (lists?.unverified.length ?? 0) && (
                      <p className="work-say">
                        {T.more(r.facts.unverified - (lists?.unverified.length ?? 0), r.facts.path)}
                      </p>
                    )}
                    <Command text={`atticus verify ${r.repo}`} label={R.copy} />
                  </>
                )}
              </CountList>
            </dd>
          </>
        )}
        <dt>{T.audit}</dt>
        <dd>
          {r.audit ? (
            <>
              {T.auditTally(T.auditFacts, r.audit.facts)} ·{" "}
              {T.auditTally(T.auditLinks, r.audit.links)}
              {/* ADR 0181: the AI's decisions, audited apart from the facts and links. */}
              {r.audit.ai && <> · {COPY.decisions.trustTally(r.audit.ai)}</>}
              {r.audit.facts.right +
                r.audit.facts.wrong +
                r.audit.links.right +
                r.audit.links.wrong <
                30 && <span className="work-say"> {T.auditSmall}</span>}
            </>
          ) : (
            <span className="mono">{T.auditNone(r.repo)}</span>
          )}
          {r.facts.present && <AnswerToggle repo={r.repo} />}
        </dd>
        <dt>{T.builtOn}</dt>
        <dd>
          {r.frameworks?.length
            ? r.frameworks
                .map((f) =>
                  f.component
                    ? T.builtOnModule(T.builtOnOne(f.name, f.version, f.cite), f.component)
                    : T.builtOnOne(f.name, f.version, f.cite),
                )
                .join(", ")
            : T.builtOnNone}
        </dd>
        <dt>{T.terms}</dt>
        <dd>
          {r.terms?.length ? (
            <ul className="mono trust-items" aria-label={`${T.terms}: ${r.repo}`}>
              {r.terms.map((t) => (
                <li key={`${t.cite}-${t.term}-${t.value}`}>
                  {T.termOne(t.term, t.value, T.termRole[t.role] ?? t.role, t.cite)}
                  {t.note !== undefined ? `; ${T.termNote(t.note)}` : ""}
                </li>
              ))}
            </ul>
          ) : (
            T.termsNone
          )}
        </dd>
        <dt>{T.commit}</dt>
        <dd className="mono">{commitWords(r)}</dd>
        <dt>{T.catalogFrom}</dt>
        <dd>
          {T.from[r.catalog.from]} · {T.records(r.catalog.fromFacts, r.catalog.fromReaders)}
          {/* App-only audit: "Nothing yet" while a rejected fact holds the repo said why. */}
          {report && report.rejected > 0 && <> · {T.rejectedHolds(report.rejected)}</>}
          {r.catalog.fromFacts + r.catalog.fromReaders > 0 && (
            <>
              {" · "}
              <a href={`#/canvas?lens=repo&node=${encodeURIComponent(`repo:${r.repo}`)}`}>
                {T.openCanvas}
              </a>
            </>
          )}
        </dd>
      </dl>
      {/* A-framework: a framework the repo declares whose patterns the facts show none of. */}
      {(r.frameworks ?? [])
        .filter((f) => f.gap)
        .map((f) => (
          <p className="work-say" key={`gap-${f.name}-${f.cite}`}>
            <strong>{T.builtOnGap(f.name)}</strong> {f.gap}
          </p>
        ))}
      {r.next && (
        <div style={{ marginTop: 8 }}>
          {/* ADR 0188: the step's button first (Read, Apply), its command folded. */}
          {appStep(r.next.command) && <Command text={r.next.command} label={R.copy} />}
          {r.next.slash && (
            <>
              <p className="work-say">{R.slash}</p>
              <Command text={r.next.slash} label={R.copySlash} />
            </>
          )}
          {!appStep(r.next.command) && (
            <>
              <p className="work-say">{R.terminal}</p>
              <Command text={r.next.command} label={R.copy} />
            </>
          )}
        </div>
      )}
      <p className="work-say mono" style={{ margin: "6px 0 0" }}>
        {T.files(r.facts.path, r.verify.path)}
      </p>
    </article>
  );
}

const F = T.fresh;
const short = (c: string) => c.slice(0, 7);

/**
 * The estate's freshness (ADR 0141, P5): the repos whose clone has moved past their facts'
 * commit, most stale first, each with the files changed that its facts cite, the facts to read
 * again and carried, and the command to copy. Fresh and unread repos are counted, not listed.
 */
export function FreshPanel({ of }: { of: Loaded<Api.FreshViewT> & { reload?: () => void } }) {
  const read = of.state === "ready" ? of.data.repos.filter((r) => r.state !== "not-read") : [];
  const moved = read.filter((r) => r.state !== "fresh");
  return (
    <Panel
      title={F.title}
      span="1 / -1"
      meta={
        read.length
          ? F.summary(
              moved.length,
              read.length,
              moved.reduce((n, r) => n + r.reread, 0),
            )
          : undefined
      }
    >
      <p className="work-why" style={{ marginTop: 0 }}>
        {F.intro}
      </p>
      <View
        of={of}
        empty={(v) => !v.repos.some((r) => r.state !== "not-read") && !v.problems.length}
        emptyText={F.empty}
      >
        {(v) => (
          <>
            <Problems list={v.problems} />
            {moved.length === 0 ? (
              <p className="work-say">{F.allFresh(read.length)}</p>
            ) : (
              <>
                <p className="row" style={{ gap: 8 }}>
                  <RunWithCopilot ask={{ kind: "stale" }} label={COPY.copilotRuns.start.stale} />
                </p>
                <table className="run-table">
                  <caption className="sr">{F.caption}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{F.col.repo}</th>
                      <th scope="col">{F.col.state}</th>
                      <th scope="col">{F.col.facts}</th>
                      <th scope="col">{F.col.clone}</th>
                      <th scope="col">{F.col.cited}</th>
                      <th scope="col">{F.col.reread}</th>
                      <th scope="col">{F.col.carried}</th>
                      <th scope="col">{F.col.run}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {moved.map((r) => (
                      <tr key={r.repo}>
                        <th scope="row" className="mono">
                          {r.repo}
                        </th>
                        <td>
                          <span className={`chip ${r.state === "moved" ? "warn" : "blocking"}`}>
                            {F.states[r.state]}
                          </span>
                        </td>
                        <td className="mono">
                          {r.factsCommits[0] ? short(r.factsCommits[0]) : ""}
                          {r.factsCommits.length > 1 ? ` ${F.more(r.factsCommits.length - 1)}` : ""}
                        </td>
                        <td className="mono">{r.head ? short(r.head) : ""}</td>
                        <td>{r.citedChanged}</td>
                        <td>{r.reread}</td>
                        <td>{r.carried}</td>
                        <td>
                          {/* ADR 0188: Read again: Copilot where allowed, else the read as a step. */}
                          <ReadRepo repo={r.repo} again ask={{ kind: "stale", repos: [r.repo] }} />
                          {r.slash && <Command text={r.slash} label={R.copySlash} />}
                          {r.command && (
                            <details className="work-terminal">
                              <summary>{COPY.appStep.inTerminal}</summary>
                              <Command text={r.command} label={R.copy} noRun />
                            </details>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {read.length > moved.length && (
                  <p className="work-say">{F.freshCount(read.length - moved.length)}</p>
                )}
              </>
            )}
          </>
        )}
      </View>
    </Panel>
  );
}

/** The tab from loaded data, so tests can render every state. */
/**
 * ADR 0181: the sample audit's precision for the AI's decisions, every repo summed, against the
 * organisation's bar (decide.minPrecision); below it, deciding pauses and this says why.
 */
export function AiPrecision({ of }: { of: Loaded<Api.DecisionsViewT> & { reload?: () => void } }) {
  const D = COPY.decisions;
  return (
    <Panel title={D.trustTitle} span="1 / -1">
      <View of={of}>
        {(v) => (
          <div className="stack" style={{ gap: 6 }}>
            <p style={{ margin: 0 }}>{D.trustTally(v.decide.precision)}</p>
            <p className="work-say" style={{ margin: 0 }}>
              {D.trustBar(v.decide.configured.minPrecision)}
            </p>
            <DecidePaused decide={v.decide} />
            <a href="#/decisions">{D.trustOpen}</a>
          </div>
        )}
      </View>
    </Panel>
  );
}

export function TrustPage({
  of,
  fresh,
  decide,
}: {
  of: Loaded<Api.TrustViewT> & { reload?: () => void };
  fresh?: Loaded<Api.FreshViewT> & { reload?: () => void };
  /** ADR 0181: GET /api/decisions, for the AI's precision row. */
  decide?: Loaded<Api.DecisionsViewT> & { reload?: () => void };
}) {
  return (
    <div className="bento">
      {fresh && <FreshPanel of={fresh} />}
      {decide && <AiPrecision of={decide} />}
      <Panel
        title={COPY.nav.screens.trust}
        span="1 / -1"
        meta={
          of.state === "ready" && of.data.repos.length
            ? T.summary(
                of.data.repos.filter((r) => r.state === "trusted").length,
                of.data.repos.length,
              )
            : undefined
        }
      >
        <p className="work-why" style={{ marginTop: 0 }}>
          {T.intro}
        </p>
        <p className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <RunWithCopilot ask={{ kind: "all" }} label={COPY.copilotRuns.start.all} />
          <RunWithCopilot ask={{ kind: "gaps" }} label={COPY.copilotRuns.start.gaps} />
        </p>
        <View
          of={of}
          empty={(v) => v.repos.length === 0 && !v.problems.length && !v.answerBoxes?.length}
          emptyText={T.empty}
        >
          {(v) => (
            <>
              <Problems list={v.problems} />
              <p className="work-say">{T.reportIn(v.factsDir)}</p>
              {v.contracts && (
                // ADR 0164: the contract check's counts, and the way to every finding.
                <p className="work-say">
                  {v.contracts.mismatches > 0 && <span aria-hidden="true">⚠ </span>}
                  {T.contracts(
                    v.contracts.mismatches,
                    v.contracts.unconfirmed,
                    v.contracts.compared,
                  )}{" "}
                  <a href={mismatchesHash}>{T.contractsOpen}</a>
                </p>
              )}
              {/* Beta.24 review: the boxes an answer's words made, each with its fixes. */}
              <AnswerBoxes boxes={v.answerBoxes} />
              <div className="stack" style={{ gap: 12 }}>
                {v.repos.map((r) => (
                  <TrustRow key={r.repo} r={r} />
                ))}
              </div>
            </>
          )}
        </View>
      </Panel>
    </div>
  );
}

export function Trust() {
  const view = useApi<Api.TrustViewT>("/api/trust");
  useReloadOnFiles(view);
  const fresh = useApi<Api.FreshViewT>("/api/trust/fresh");
  useReloadOnFiles(fresh);
  const ds = useDecisions();
  return (
    <EvidenceProvider>
      <TrustPage
        of={view}
        fresh={fresh}
        decide={{ ...(ds?.view ?? { state: "loading" }), ...(ds ? { reload: ds.reload } : {}) }}
      />
    </EvidenceProvider>
  );
}
