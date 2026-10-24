import type { Api } from "@maycombhq/core";
import { useApi, useReloadOnFiles, type Loaded } from "../../api/client.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { Command, Problems } from "../work/RunNext.js";
import "../work/work.css";

/**
 * Map › Trust (ADR 0124): how far to trust each repo's map, from the files the verifier writes.
 * Per repo: the facts it kept and rejected, how much of the code they cover and the files not
 * read yet, the facts' commit against the checkout's, whether the catalog is built from the
 * facts or the built-in readers, and the command to run next. It reads files only
 * (`GET /api/trust`); the app runs nothing.
 */

const T = COPY.trust;
const R = COPY.runNext;

type Repo = Api.TrustRepoT;

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

export function TrustRow({ r }: { r: Repo }) {
  const report = r.verify.report;
  const head = `trust-${r.repo}`;
  return (
    <article className="list-row" style={{ display: "block" }} aria-labelledby={head}>
      <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
        <h3 id={head} className="h" style={{ fontSize: 14, margin: 0 }}>
          {r.repo}
        </h3>
        <span className={`chip ${trustChip(r.state)}`}>{T.states[r.state]}</span>
      </div>
      <p className="work-why" style={{ margin: "6px 0" }}>
        {trustWhy(r)}
      </p>
      <dl className="run-facts" style={{ margin: "8px 0" }}>
        <dt>{T.kept}</dt>
        <dd>
          {report ? report.accepted : T.noReport}
          {report && report.redacted > 0 ? ` (${T.redacted(report.redacted)})` : ""}
        </dd>
        <dt>{T.rejected}</dt>
        <dd>{report ? report.rejected : T.noReport}</dd>
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
        </dd>
        <dt>{T.commit}</dt>
        <dd className="mono">{commitWords(r)}</dd>
        <dt>{T.catalogFrom}</dt>
        <dd>
          {T.from[r.catalog.from]} · {T.records(r.catalog.fromFacts, r.catalog.fromReaders)}
        </dd>
      </dl>
      {report && report.unknownFiles.length > 0 && (
        <details>
          <summary>{T.unknownFiles(report.coverage.unknown)}</summary>
          <ul className="mono" style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 12 }}>
            {report.unknownFiles.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          {report.coverage.unknown > report.unknownFiles.length && (
            <p className="work-say">
              {T.more(report.coverage.unknown - report.unknownFiles.length, r.verify.path)}
            </p>
          )}
        </details>
      )}
      {r.next && (
        <div style={{ marginTop: 8 }}>
          {r.next.slash && (
            <>
              <p className="work-say">{R.slash}</p>
              <Command text={r.next.slash} label={R.copySlash} />
            </>
          )}
          <p className="work-say">{R.terminal}</p>
          <Command text={r.next.command} label={R.copy} />
        </div>
      )}
      <p className="work-say mono" style={{ margin: "6px 0 0" }}>
        {T.files(r.facts.path, r.verify.path)}
      </p>
    </article>
  );
}

/** The tab from loaded data, so tests can render every state. */
export function TrustPage({ of }: { of: Loaded<Api.TrustViewT> & { reload?: () => void } }) {
  return (
    <div className="bento">
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
        <View of={of} empty={(v) => v.repos.length === 0 && !v.problems.length} emptyText={T.empty}>
          {(v) => (
            <>
              <Problems list={v.problems} />
              <p className="work-say">{T.reportIn(v.factsDir)}</p>
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
  return <TrustPage of={view} />;
}
