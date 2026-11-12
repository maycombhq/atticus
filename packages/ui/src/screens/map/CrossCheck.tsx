import { useEffect, useMemo, useState } from "react";
import type { Api } from "@maycombhq/core";
import { api, useApi, useReloadOnFiles, type Loaded } from "../../api/client.js";
import { ShowInConsole } from "../../app/activity.js";
import { followJob, JobFailed } from "../../app/job.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { queryParam, setQueryParam } from "../know/common.js";
import { ConfirmDialog, whyStopped } from "../setup/CatalogBuild.js";
import "./crosscheck.css";

/** The promote job's code when the promote itself refused (cli/src/ui-api-catalog.ts). */
const PROMOTE_REFUSED = 3;

/** Promote to assert: the preview of the person's fact, and the write then verify, as a job. */
export interface PromoteSteps {
  preview: (repo: string, key: string) => Promise<Api.CrossCheckPromoteViewT>;
  promote: (repo: string, key: string, sha256: string) => Promise<unknown>;
}

/**
 * Map › Trust › Readers found / facts say (ADR 0195 point 3, ticket CS3). For each repo with
 * verified facts, what the built-in readers found is set beside what the facts say: what only the
 * readers found, where the two disagree (both values, each with its line), and what only the
 * facts have. The facts are the map and nothing here changes the catalog: a person checks the
 * cited line, then dismisses what the readers got wrong (`atticus catalog crosscheck <repo>
 * --dismiss`, run as a local job, its lines in the Console), which is listed again when the
 * readers' value changes; or promotes what the readers got right to their own fact (`--promote`,
 * the fact and its cited line shown first, then `atticus verify <repo>` in the same job), and the
 * item says whether the verifier found it on its line. Reads GET /api/crosscheck and
 * /api/crosscheck/{repo}.
 */

const X = COPY.crossCheck;

type Item = Api.CrossCheckItemT;
type Repo = Api.RepoCrossCheckT;
export type Show = "readers-only" | "disagree" | "facts-only" | "dismissed" | "all";
const SHOWS: Show[] = ["readers-only", "disagree", "facts-only", "dismissed", "all"];

const short = (c?: string) => (c && /^[0-9a-f]{8,}$/.test(c) ? c.slice(0, 7) : (c ?? ""));

/** A value in words: a string as it is, an object's fields one after another. */
export function valueText(v: unknown): string {
  if (v === undefined || v === null) return X.nothing;
  if (typeof v === "string") return v;
  if (typeof v === "object" && !Array.isArray(v))
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${k}: ${typeof x === "string" ? x : JSON.stringify(x)}`)
      .join(" · ");
  return JSON.stringify(v);
}

/** The items a filter keeps: by state (dismissed ones only under Dismissed and All), kind and words. */
export function itemsShown(
  items: readonly Item[],
  f: { show: Show; kind: string; find: string },
): Item[] {
  const words = f.find.trim().toLowerCase();
  return items.filter((i) => {
    if (
      f.show === "dismissed"
        ? !i.dismissed
        : f.show !== "all" && (i.dismissed || i.state !== f.show)
    )
      return false;
    if (f.kind && i.kind !== f.kind) return false;
    if (!words) return true;
    const hay = [
      i.key,
      i.readers?.id,
      i.facts?.id,
      ...(i.readers?.cites ?? []).map((c) => c.file),
      ...(i.facts?.cites ?? []).map((c) => c.file),
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(words);
  });
}

/** How many items each filter shows. */
export function showCounts(items: readonly Item[]): Record<Show, number> {
  return {
    "readers-only": items.filter((i) => i.state === "readers-only" && !i.dismissed).length,
    disagree: items.filter((i) => i.state === "disagree" && !i.dismissed).length,
    "facts-only": items.filter((i) => i.state === "facts-only").length,
    dismissed: items.filter((i) => i.dismissed).length,
    all: items.length,
  };
}

/** The filter a repo opens on: what the readers found, else the disagreements, else all. */
export function firstShow(items: readonly Item[]): Show {
  const n = showCounts(items);
  return n["readers-only"] ? "readers-only" : n.disagree ? "disagree" : "all";
}

type Cite = NonNullable<Item["readers"]>["cites"][number];

function Cites({ cites, commit }: { cites: readonly Cite[]; commit?: string }) {
  if (!cites.length) return null;
  return (
    <ul className="xc-cites mono">
      {cites.map((c) => (
        <li key={`${c.file}:${c.line ?? ""}`}>
          {c.file}
          {c.line ? `:${c.line}` : ""}
          {c.commit && c.commit !== commit ? ` @ ${short(c.commit)}` : ""}
        </li>
      ))}
    </ul>
  );
}

/** The person's fact promoting an item writes, shown before it is written. */
export function PromotePreview({ plan }: { plan: Api.CrossCheckPromoteViewT }) {
  const c = plan.cite!;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <p style={{ margin: 0 }}>{X.promoteFact(plan.factKind ?? "", plan.fact ?? "")}</p>
      <p className="mono" style={{ margin: 0 }}>
        {X.promoteCite(`${c.file}:${c.line}`, short(c.commit))}
      </p>
      {c.text !== undefined ? (
        <pre className="xc-line mono">{c.text}</pre>
      ) : (
        <p className="work-say" style={{ margin: 0 }}>
          {X.promoteNoText}
        </p>
      )}
      <p style={{ margin: 0 }}>{X.promoteValue(c.value)}</p>
      <p className="work-say" style={{ margin: 0 }}>
        {plan.already ? X.promoteAlready : X.promoteInto(plan.factsFile)}
        {plan.fromSnapshot ? ` ${X.promoteFromSnapshot(plan.factsFile)}` : ""}
      </p>
    </div>
  );
}

/** Where a promoted item's fact stands: verified on its line, not yet, or rejected with why. */
function PromotedNote({ repo, p }: { repo: string; p: NonNullable<Item["promoted"]> }) {
  return (
    <div className="stack" style={{ gap: 2 }}>
      <span
        style={{ alignSelf: "flex-start" }}
        className={`chip ${p.state === "verified" ? "done" : p.state === "rejected" ? "blocking" : "warn"}`}
      >
        {X.promoted[p.state] ?? p.state}
      </span>
      <span className="work-say mono">
        {p.fact} · {p.file}:{p.line}
      </span>
      {p.state === "verified" && <span className="work-say">{X.promotedVerifiedHint(repo)}</span>}
      {p.state === "rejected" && (
        <span className="work-say">
          {p.message ? `${p.message} ` : ""}
          {X.promotedRejectedHint}
        </span>
      )}
    </div>
  );
}

/** Dismiss, or List again, as the CLI command run as a local job; and Promote to assert. */
export function ItemAction(p: {
  repo: string;
  item: Item;
  run: (repo: string, key: string, undo: boolean, sha256?: string) => Promise<{ lines: string[] }>;
  steps?: PromoteSteps | undefined;
  onDone: (note: string, job?: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [reading, setReading] = useState(false);
  const [asking, setAsking] = useState<Api.CrossCheckPromoteViewT | undefined>();
  if (p.item.state === "facts-only") return <p className="work-say xc-note">{X.factsOnlyNote}</p>;
  const undo = !!p.item.dismissed;
  const canPromote =
    !!p.steps &&
    p.item.state === "readers-only" &&
    !p.item.dismissed &&
    (!p.item.promoted || p.item.promoted.state === "rejected");
  const openPromote = () => {
    setReading(true);
    setError(undefined);
    p.steps!.preview(p.repo, p.item.key)
      .then(
        (plan) => (plan.can ? setAsking(plan) : setError(X.promoteCant(plan.why ?? ""))),
        (e: unknown) => setError(X.failed(whyStopped(e))),
      )
      .finally(() => setReading(false));
  };
  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await p.run(p.repo, p.item.key, undo, undo ? undefined : p.item.readersSha256);
      p.onDone(undo ? X.undismissedNote(p.item.key) : X.dismissedNote(p.item.key));
    } catch (e) {
      setError(
        X.failed(
          e instanceof JobFailed
            ? e.lines.join(" ") || e.message
            : e instanceof Error
              ? e.message
              : String(e),
        ),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn"
          disabled={busy}
          aria-busy={busy}
          aria-label={undo ? X.undismissOf(p.item.key) : X.dismissOf(p.item.key)}
          onClick={() => void go()}
        >
          {busy ? X.working : undo ? X.undismiss : X.dismiss}
        </button>
        {canPromote && (
          <button
            type="button"
            className="btn"
            disabled={reading || busy}
            aria-busy={reading}
            aria-label={X.promoteOf(p.item.key)}
            onClick={openPromote}
          >
            {reading ? X.promoteLoading : X.promote}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="state error" style={{ margin: 0 }}>
          {error}
        </p>
      )}
      {asking && (
        <ConfirmDialog
          title={X.promoteTitle}
          intro={X.promoteIntro(p.repo)}
          confirm={X.promoteConfirm}
          working={X.working}
          onConfirm={async () => {
            try {
              await p.steps!.promote(p.repo, p.item.key, asking.sha256!);
              setAsking(undefined);
              p.onDone(X.promotedNote(p.item.key));
            } catch (e) {
              // Verify rejecting the fact ends the job unsuccessfully: the item says why.
              if (!(e instanceof JobFailed)) throw e;
              setAsking(undefined);
              // The promote itself refused (nothing written): said as the promote's, not verify's.
              if (e.code === PROMOTE_REFUSED) {
                setError(X.promoteRefused(e.lines.at(-1) ?? e.message));
                return;
              }
              // The last line is why verify stopped (the lines before are the promote's own, in the Console).
              setError(X.promoteVerifyStopped(e.lines.at(-1) ?? e.message));
              p.onDone(X.promotedNote(p.item.key));
            }
          }}
          onClose={() => setAsking(undefined)}
        >
          <PromotePreview plan={asking} />
        </ConfirmDialog>
      )}
    </div>
  );
}

function ItemRow(p: {
  repo: Repo;
  item: Item;
  run: (repo: string, key: string, undo: boolean, sha256?: string) => Promise<{ lines: string[] }>;
  steps?: PromoteSteps | undefined;
  onDone: (note: string) => void;
}) {
  const { item: i } = p;
  return (
    <li className={`xc-item xc-${i.state}`}>
      <div className="xc-head">
        <span
          className={`chip ${i.state === "facts-only" ? "dim" : i.state === "disagree" ? "blocking" : "warn"}`}
        >
          {X.itemState[i.state] ?? i.state}
        </span>
        <span className="hud">{i.kind}</span>
        {i.dismissed && <span className="chip dim">{X.dismissed}</span>}
      </div>
      <p className="xc-key mono">{i.key.slice(i.kind.length + 1)}</p>
      {i.state === "disagree" ? (
        <table className="xc-fields">
          <caption className="sr">{X.fieldsCaption(i.key)}</caption>
          <thead>
            <tr>
              <th scope="col">{X.field}</th>
              <th scope="col">{X.readersSay}</th>
              <th scope="col">{X.factsSay}</th>
            </tr>
          </thead>
          <tbody>
            {(i.fields ?? []).map((f) => (
              <tr key={f.field}>
                <th scope="row" className="mono">
                  {f.field}
                </th>
                <td className="mono">{valueText(f.readers)}</td>
                <td className="mono">{valueText(f.facts)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="xc-value mono">{valueText((i.readers ?? i.facts)?.value)}</p>
      )}
      <div className="xc-sides">
        {i.readers && (
          <div>
            <span className="hud">{X.readersSay}</span>
            <Cites
              cites={i.readers.cites}
              {...(p.repo.readersCommit ? { commit: p.repo.readersCommit } : {})}
            />
          </div>
        )}
        {i.facts && (
          <div>
            <span className="hud">{X.factsSay}</span>
            <Cites
              cites={i.facts.cites}
              {...(p.repo.factsCommit ? { commit: p.repo.factsCommit } : {})}
            />
          </div>
        )}
      </div>
      {i.promoted && <PromotedNote repo={p.repo.repo} p={i.promoted} />}
      <ItemAction repo={p.repo.repo} item={i} run={p.run} steps={p.steps} onDone={p.onDone} />
    </li>
  );
}

/** One repo's cross-check: its commits, the filters, the items. */
export function RepoCrossCheckView(p: {
  of: Loaded<Repo> & { reload?: () => void };
  show: Show | undefined;
  onShow: (s: Show) => void;
  run: (repo: string, key: string, undo: boolean, sha256?: string) => Promise<{ lines: string[] }>;
  steps?: PromoteSteps | undefined;
  onChanged?: () => void;
}) {
  const [kind, setKind] = useState("");
  const [find, setFind] = useState("");
  const [note, setNote] = useState<string | undefined>();
  return (
    <View of={p.of}>
      {(r) => {
        if (r.state !== "compared")
          return (
            <div className="state" role="note">
              <p style={{ margin: 0 }}>{X.state[r.state]}</p>
              {r.problem && (
                <p className="work-say mono" style={{ margin: "4px 0 0" }}>
                  {r.problem}
                </p>
              )}
              {(r.readersCommit || r.factsCommit) && (
                <p className="work-say" style={{ margin: "4px 0 0" }}>
                  {X.commits(short(r.readersCommit) || "–", short(r.factsCommit) || "–")}
                </p>
              )}
            </div>
          );
        const counts = showCounts(r.items);
        const show = p.show ?? firstShow(r.items);
        const kinds = [...new Set(r.items.map((i) => i.kind))].sort((a, b) => a.localeCompare(b));
        const shown = itemsShown(r.items, { show, kind, find });
        const behind =
          r.head &&
          r.readersCommit &&
          !r.head.startsWith(r.readersCommit) &&
          !r.readersCommit.startsWith(r.head);
        return (
          <div className="stack" style={{ gap: 10 }}>
            <p className="work-say" style={{ margin: 0 }}>
              {X.commits(short(r.readersCommit), short(r.factsCommit))}
              {behind && ` ${X.behind(short(r.head))}`}
            </p>
            <p className="hud" style={{ margin: 0 }}>
              {X.counts(
                r.counts.readersOnly,
                r.counts.disagree,
                r.counts.factsOnly,
                r.counts.agree,
              )}
            </p>
            {r.items.length === 0 ? (
              <div className="state">{X.allAgree}</div>
            ) : (
              <>
                <div className="xc-filters">
                  <fieldset className="xc-show">
                    <legend className="hud">{X.filterLabel}</legend>
                    {SHOWS.map((s) => (
                      <label key={s} className={`xc-seg${s === show ? " on" : ""}`}>
                        <input
                          type="radio"
                          name={`xc-show-${r.repo}`}
                          value={s}
                          checked={s === show}
                          onChange={() => p.onShow(s)}
                        />
                        {X.filter[s]!(counts[s])}
                      </label>
                    ))}
                  </fieldset>
                  <div className="xc-narrow">
                    <div className="stack" style={{ gap: 4 }}>
                      <label htmlFor="xc-kind" className="hud">
                        {X.kindLabel}
                      </label>
                      <select
                        id="xc-kind"
                        className="field"
                        value={kind}
                        onChange={(e) => setKind(e.target.value)}
                      >
                        <option value="">{X.allKinds}</option>
                        {kinds.map((k) => (
                          <option key={k} value={k}>
                            {k}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="stack" style={{ gap: 4 }}>
                      <label htmlFor="xc-find" className="hud">
                        {X.searchLabel}
                      </label>
                      <input
                        id="xc-find"
                        type="search"
                        className="field"
                        placeholder={X.searchHint}
                        value={find}
                        onChange={(e) => setFind(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
                <p role="status" className="hud" style={{ margin: 0 }}>
                  {X.shown(shown.length, r.items.length)}
                  {note ? ` · ${note}` : ""}
                </p>
                {shown.length === 0 ? (
                  <div className="state">{X.noneShown}</div>
                ) : (
                  <ul className="xc-list" aria-label={X.listLabel(r.repo)}>
                    {shown.map((i) => (
                      <ItemRow
                        key={`${i.state}|${i.key}`}
                        repo={r}
                        item={i}
                        run={p.run}
                        steps={p.steps}
                        onDone={(n) => {
                          setNote(n);
                          p.of.reload?.();
                          p.onChanged?.();
                        }}
                      />
                    ))}
                  </ul>
                )}
                <p className="work-say" style={{ margin: 0 }}>
                  {X.dismissHint} {X.proposeHint} <span className="mono">{r.dismissals}</span>
                </p>
              </>
            )}
          </div>
        );
      }}
    </View>
  );
}

/** The repos to pick from: those compared first, then the rest, each in manifest order. */
export function reposInOrder(v: Api.CrossCheckViewT): Repo[] {
  return [
    ...v.repos.filter((r) => r.state === "compared"),
    ...v.repos.filter((r) => r.state !== "compared"),
  ];
}

/** The page from its loaded views, so tests can render every state. */
export function CrossCheckPage(p: {
  list: Loaded<Api.CrossCheckViewT> & { reload?: () => void };
  repo: string | undefined;
  onRepo: (repo: string) => void;
  one: (Loaded<Repo> & { reload?: () => void }) | undefined;
  show: Show | undefined;
  onShow: (s: Show) => void;
  run: (repo: string, key: string, undo: boolean, sha256?: string) => Promise<{ lines: string[] }>;
  steps?: PromoteSteps | undefined;
  job?: string | undefined;
}) {
  return (
    <div className="bento xc">
      <Panel title={X.title} span="1 / -1">
        <p className="work-why" style={{ marginTop: 0 }}>
          {X.intro}
        </p>
        <View
          of={p.list}
          empty={(v) => !v.repos.some((r) => r.state !== "no-facts") && !v.problems.length}
          emptyText={X.empty}
        >
          {(v) => {
            const repos = reposInOrder(v);
            const picked = p.repo ?? repos[0]?.repo ?? "";
            return (
              <div className="stack" style={{ gap: 12 }}>
                {v.problems.length > 0 && (
                  <div className="state error" role="alert">
                    <p style={{ margin: 0 }}>{X.problems}</p>
                    <ul style={{ margin: 0 }}>
                      {v.problems.map((x) => (
                        <li key={x.file}>
                          <span className="mono">{x.file}</span>: {x.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="stack" style={{ gap: 4, maxWidth: 360 }}>
                  <label htmlFor="xc-repo" className="hud">
                    {X.repoPicker}
                  </label>
                  <select
                    id="xc-repo"
                    className="field"
                    value={picked}
                    onChange={(e) => p.onRepo(e.target.value)}
                  >
                    {repos.map((r) => (
                      <option key={r.repo} value={r.repo}>
                        {r.state === "compared"
                          ? `${r.repo} · ${X.pickerCounts(r.counts.readersOnly, r.counts.disagree)}`
                          : `${r.repo} · ${X.state[r.state]?.split(":")[0] ?? r.state}`}
                      </option>
                    ))}
                  </select>
                </div>
                <ShowInConsole id={p.job} />
                {p.one && (
                  <RepoCrossCheckView
                    of={p.one}
                    show={p.show}
                    onShow={p.onShow}
                    run={p.run}
                    steps={p.steps}
                    onChanged={p.list.reload}
                  />
                )}
              </div>
            );
          }}
        </View>
      </Panel>
    </div>
  );
}

/** Map › Readers found / facts say, with its repo and filter in the address (?repo=, ?show=). */
export function CrossCheck({ hash }: { hash: string }) {
  const list = useApi<Api.CrossCheckViewT>("/api/crosscheck");
  const [repo, setRepo] = useState(() => queryParam(hash, "repo"));
  const [show, setShow] = useState<Show | undefined>(() => {
    const s = queryParam(hash, "show") as Show | undefined;
    return s && SHOWS.includes(s) ? s : undefined;
  });
  const [job, setJob] = useState<string | undefined>();
  useEffect(() => {
    setRepo(queryParam(hash, "repo"));
    const s = queryParam(hash, "show") as Show | undefined;
    setShow(s && SHOWS.includes(s) ? s : undefined);
  }, [hash]);
  const first = useMemo(
    () => (list.state === "ready" ? reposInOrder(list.data)[0]?.repo : undefined),
    [list],
  );
  const picked = repo ?? first;
  const one = useApi<Repo>(picked ? `/api/crosscheck/${encodeURIComponent(picked)}` : undefined);
  useReloadOnFiles(list, one);
  const run = (r: string, key: string, undo: boolean, sha256?: string) =>
    followJob(
      `/api/crosscheck/${encodeURIComponent(r)}/dismiss`,
      undo ? { key, undo: true } : { key, ...(sha256 ? { sha256 } : {}) },
      undefined,
      setJob,
    );
  const steps: PromoteSteps = {
    preview: (r, key) =>
      api<Api.CrossCheckPromoteViewT>(
        `/api/crosscheck/${encodeURIComponent(r)}/promote?key=${encodeURIComponent(key)}`,
      ),
    promote: (r, key, sha256) =>
      followJob(
        `/api/crosscheck/${encodeURIComponent(r)}/promote`,
        { key, sha256 },
        undefined,
        setJob,
      ),
  };
  return (
    <CrossCheckPage
      list={list}
      repo={picked}
      onRepo={(r) => {
        setRepo(r);
        setShow(undefined);
        setQueryParam("crosscheck", "repo", r, { drop: ["show"] });
      }}
      one={picked ? one : undefined}
      show={show}
      onShow={(s) => {
        setShow(s);
        setQueryParam("crosscheck", "show", s);
      }}
      run={run}
      steps={steps}
      job={job}
    />
  );
}
