import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApplyAndPropose } from "../app/propose.js";
import type { Api, Question } from "@maycombhq/core";
import { api, useApi, useReloadOnFiles, type Loaded } from "../api/client.js";
import { Panel, View } from "../app/ui.js";
import { COPY } from "../copy.js";
import { Choice, CopyButton, message } from "./run/shared.js";
import { FilterBox, FilterCount, FilterEmpty, filteredWhat, matchesWords } from "../app/filter.js";
import { OwnerQuestionList, questionsKind, type QuestionsKind } from "./OwnerQuestions.js";

/**
 * The Questions page (ADR 0078, plan Phase 2a): the questions a step raised for a person, each
 * with its options and the file and line it read, and a form to answer. The answer is written
 * to questions/<id>.yaml by the local API; the page then shows the command to run next. It
 * never runs the step itself.
 */

const C = COPY.questions;

export type QuestionView = Question;
export interface QuestionListView {
  questions: QuestionView[];
  problems: { file: string; message: string }[];
  /** ADR 0140: what each rests on, the calls it joins and its owner. */
  about?: Api.QuestionListT["about"];
  /** ADR 0140: with mine=true, the person and their teams. */
  me?: Api.QuestionListT["me"];
  /** beta.21: every question on file by state, and per repo. */
  counts?: Api.QuestionListT["counts"];
}

type About = NonNullable<Api.QuestionListT["about"]>[string];

/** Who a question goes to, what change rests on it and how many calls it joins (ADR 0140). */
export function aboutWords(a: About | undefined): string[] {
  if (!a) return [];
  return [
    ...(a.restsOn.length ? [C.restsOn(a.restsOn)] : []),
    "team" in a.owner
      ? C.owner(a.owner.team, a.owner.name)
      : "change" in a.owner
        ? C.changeOwner(a.owner.change, a.owner.people)
        : C.noOwner(a.owner.none),
    ...(a.joins ? [C.joins(a.joins)] : []),
    ...(a.proposal ? [C.proposal.listed] : []),
    ...(a.rule ? [C.rule.offerListed(a.rule.ids.length, a.rule.match)] : []),
  ];
}

type Proposal = NonNullable<About["proposal"]>;
/** ADR 0168: the rule one answer could take to cover the open questions like this one. */
type RuleOffer = NonNullable<About["rule"]>;

/**
 * The answer the assistant proposed (ADR 0144, Q5), shown only once every line it cites was
 * checked, with Accept: the person's click makes it their answer, by them. It never answers alone.
 */
export function ProposalView(p: {
  question: QuestionView;
  proposal: Proposal;
  busy: boolean;
  onAccept: () => void;
}) {
  const P = C.proposal;
  const { question: q, proposal: x } = p;
  const head = `proposal-${q.id}`;
  return (
    <section aria-labelledby={head} className="stack" style={{ gap: 6 }}>
      <h3 id={head} className="hud" style={{ margin: 0, fontSize: 10 }}>
        {P.title}
      </h3>
      <p className="muted" style={{ margin: 0 }}>
        {P.notYet(x.by)}
      </p>
      <p style={{ margin: 0 }}>
        <strong>
          {x.answer.option !== undefined
            ? P.option(x.answer.option, q.options[x.answer.option - 1]?.label ?? "")
            : P.words(x.answer.text ?? "")}
        </strong>
      </p>
      <p style={{ margin: 0 }}>{x.why}</p>
      <h4 className="hud" style={{ margin: 0, fontSize: 10 }}>
        {P.cites}
      </h4>
      <ul style={{ margin: 0 }}>
        {x.cites.map((c) => (
          <li key={`${c.repo ?? q.repo}:${c.file}:${c.line}`}>
            <span className="mono">
              {c.repo ?? q.repo} {c.file}:{c.line}
            </span>{" "}
            <q>{c.quote}</q>
          </li>
        ))}
      </ul>
      <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" className="btn primary" disabled={p.busy} onClick={p.onAccept}>
          {p.busy ? P.accepting : P.accept}
        </button>
        <code className="mono">{P.command(q.id)}</code>
        <CopyButton text={P.command(q.id)} label={C.copy} />
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {P.orAnswer}
      </p>
    </section>
  );
}
export interface AnsweredResult {
  question: QuestionView;
  rerun: string;
  skill?: { path: string; written: boolean };
  /** ADR 0162: the system a target answer wrote into the profile. */
  system?: { id: string; profile: string; added: boolean };
}

type Pick = Api.TargetPickListT["picks"][number];

/**
 * The "Another repo…" picker (ADR 0162, F8): every repo of the manifest (read or not), every system
 * of the profile and every team in roles.yaml, from GET /api/questions/{id}/targets; or a vendor's
 * name not listed. A team with no system, or a new vendor, is added to the profile only when the
 * person ticks the box: a file change for review, never a write to a shared system.
 */
export function TargetPicker(p: {
  id: string;
  form: AnswerForm;
  set: (f: Partial<AnswerForm>) => void;
}) {
  const list = useApi<Api.TargetPickListT>(`/api/questions/${p.id}/targets`);
  return <TargetPickerView {...p} of={list} />;
}

/** The picker as it renders the list's loading, error, empty and ready states. */
export function TargetPickerView(p: {
  id: string;
  form: AnswerForm;
  set: (f: Partial<AnswerForm>) => void;
  of: Loaded<Api.TargetPickListT>;
}) {
  const A = C.another;
  const list = p.of;
  const name = `q-${p.id}-target`;
  if (list.state === "loading")
    return (
      <p role="status" aria-busy="true" className="muted" style={{ margin: 0 }}>
        {A.loading}
      </p>
    );
  if (list.state === "error")
    return (
      <p role="alert" className="state error" style={{ margin: 0 }}>
        {A.failed(list.error)}
      </p>
    );
  const picks = list.data.picks;
  if (!picks.length)
    return (
      <p className="state" style={{ margin: 0 }}>
        {A.empty}
      </p>
    );
  const chosen = picks.find((x) => x.id === p.form.target);
  const typed = !chosen && p.form.target ? p.form.target : "";
  const pickTo = (x: Pick | undefined, words?: string) =>
    p.set({
      target: x ? x.id : (words ?? ""),
      addSystem: undefined,
      needsSystem: x ? (x.adds ? "internal" : undefined) : words?.trim() ? "vendor" : undefined,
    });
  const group = (kind: Pick["kind"], label: string) => {
    const xs = picks.filter((x) => x.kind === kind);
    return xs.length ? (
      <optgroup label={label}>
        {xs.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
            {kind === "repo" && !x.read ? ` (${A.notRead})` : ""}
            {kind === "system" && x.boundary ? ` (${x.boundary})` : ""}
            {kind === "team" && x.adds ? ` (${A.noSystem})` : ""}
          </option>
        ))}
      </optgroup>
    ) : null;
  };
  return (
    <div className="stack" style={{ gap: 6, marginLeft: 24 }}>
      <label htmlFor={`${name}-pick`} className="hud" style={{ fontSize: 10 }}>
        {A.label}
      </label>
      <select
        id={`${name}-pick`}
        className="field"
        value={chosen?.id ?? ""}
        onChange={(e) => pickTo(picks.find((x) => x.id === e.target.value))}
      >
        <option value="">{A.choose}</option>
        {group("repo", A.repos)}
        {group("system", A.systems)}
        {group("team", A.teams)}
      </select>
      <label htmlFor={`${name}-new`} className="hud" style={{ fontSize: 10 }}>
        {A.newVendor}
      </label>
      <input
        id={`${name}-new`}
        className="field"
        value={typed}
        aria-describedby={`${name}-new-d`}
        onChange={(e) => pickTo(undefined, e.target.value)}
      />
      <span id={`${name}-new-d`} className="muted" style={{ fontSize: 12 }}>
        {A.newVendorHint}
      </span>
      {p.form.needsSystem && (
        <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
          <input
            type="checkbox"
            id={`${name}-add`}
            checked={!!p.form.addSystem}
            onChange={(e) =>
              p.set({ addSystem: e.target.checked ? p.form.needsSystem : undefined })
            }
          />
          <label htmlFor={`${name}-add`}>
            {chosen?.adds
              ? A.addTeam(chosen.id, chosen.adds.name)
              : A.addVendor(p.form.target ?? "")}
          </label>
        </div>
      )}
    </div>
  );
}

const ID = /^q-[0-9a-f]{12}$/;

type Excerpt = Api.QuestionEvidenceListT["excerpts"][number];

/**
 * The lines around one cited line (WP7.2), the cited one marked, so the answer is given looking
 * at the code; just its reference when it can't be shown.
 */
export function ExcerptView({ e }: { e: Excerpt }) {
  return (
    <figure style={{ margin: 0 }}>
      <figcaption>
        <code className="mono">{e.ref}</code>
        {!e.found && (
          <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>
            {C.notShown}
          </span>
        )}
      </figcaption>
      {e.found && (
        <pre className="mono" style={{ margin: "4px 0 0", fontSize: 12, overflowX: "auto" }}>
          {e.lines.map((l, i) => {
            const n = e.start + i;
            const cited = n === e.line;
            return (
              <span key={n} style={{ display: "block" }} aria-current={cited ? "true" : undefined}>
                <span className="muted">{`${String(n).padStart(4)}  `}</span>
                {cited ? <mark>{l}</mark> : l}
              </span>
            );
          })}
        </pre>
      )}
    </figure>
  );
}

function Evidence({ id, refs }: { id: string; refs: string[] }) {
  const ex = useApi<Api.QuestionEvidenceListT>(`/api/questions/${id}/evidence`);
  if (ex.state !== "ready")
    return (
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {refs.map((e) => (
          <li key={e}>
            <code className="mono">{e}</code>
          </li>
        ))}
      </ul>
    );
  return (
    <div className="stack" style={{ gap: 8 }}>
      {ex.data.excerpts.map((e) => (
        <ExcerptView key={e.ref} e={e} />
      ))}
    </div>
  );
}

/** The question id in #/questions/<id>, if any. */
export function questionRoute(hash: string): string | undefined {
  const raw = hash.replace(/^#\/?/, "").split(/[?]/)[0]!.split("/")[1] ?? "";
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  return ID.test(id) ? id : undefined;
}

export interface AnswerForm {
  /** An option number, or "words" for the person's own words; undefined until picked. */
  pick: number | "words" | undefined;
  text: string;
  scope: "repo" | "repo-type";
  repoType: string;
  /** ADR 0153 (Q2): a host pattern or a path prefix the answer covers; empty for none. */
  match?: string;
  /** ADR 0162 (F8): the option picked is "Another repo…": the target named from the picker. */
  another?: boolean;
  target?: string;
  /** A vendor or a team with no system: the person agreed to add it to the profile. */
  addSystem?: "vendor" | "internal";
  /** The picked target needs a system added (a team with none, or a vendor not listed). */
  needsSystem?: "vendor" | "internal";
}

/** The option of a targets question that opens the picker (ADR 0162). */
export const ANOTHER_REPO = "Another repo…";
/** The option of a topics question that opens the same picker (ADR 0162). */
export const TOPIC_OUTSIDE = "A topic owned by another team or vendor";
/** The steps whose questions have a picker, with the option that opens it. */
export const PICKER_OPTIONS: Readonly<Record<string, string>> = {
  "facts-targets": ANOTHER_REPO,
  "facts-topics": TOPIC_OUTSIDE,
};

/** The steps whose answers take a rule (ADR 0153): where calls go, by target or by host. */
export const RULE_STEPS: ReadonlySet<string> = new Set(["facts-targets", "scan-hosts"]);

/** The POST body for the form, or what is missing in words. */
export function answerBody(f: AnswerForm): { body: Record<string, unknown> } | { error: string } {
  if (f.pick === undefined) return { error: C.pickOne };
  if (f.another) {
    if (!f.target?.trim()) return { error: C.another.pickOne };
    if (f.needsSystem && !f.addSystem) return { error: C.another.needAdd };
  }
  const what = f.another
    ? { target: f.target!.trim(), ...(f.addSystem ? { addSystem: f.addSystem } : {}) }
    : f.pick === "words"
      ? f.text.trim()
        ? { text: f.text.trim() }
        : undefined
      : { option: f.pick };
  if (!what) return { error: C.needWords };
  const rule = f.match?.trim() ? { match: f.match.trim() } : {};
  if (f.scope === "repo-type") {
    if (!f.repoType.trim()) return { error: C.needType };
    return { body: { ...what, scope: "repo-type", repoType: f.repoType.trim(), ...rule } };
  }
  return { body: { ...what, scope: "repo", ...rule } };
}

const day = (iso: string) => iso.slice(0, 10);
const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/** The repos the questions are about, in order. */
export const questionRepos = (qs: QuestionView[]): string[] =>
  [...new Set(qs.map((q) => q.repo))].sort((a, b) => a.localeCompare(b));

/** The questions the filter keeps: its words in the question, id or repo, and the repo picked. */
export const shownQuestions = (qs: QuestionView[], f: { text: string; repo: string }) =>
  qs.filter(
    (q) => (!f.repo || q.repo === f.repo) && matchesWords([q.question, q.id, q.repo], f.text),
  );

const FILTER_ID = "questions-filter";

/** The questions by repo, in the repos' order, each repo's in the order given. */
export function byRepo(qs: QuestionView[]): [string, QuestionView[]][] {
  const out = new Map<string, QuestionView[]>();
  for (const r of questionRepos(qs)) out.set(r, []);
  for (const q of qs) out.get(q.repo)!.push(q);
  return [...out];
}

/** The list's address: open or all, everyone's or the person's teams' (ADR 0140). */
export function questionsUrl(filter: "open" | "all", whose: "all" | "mine"): string {
  const q = [
    ...(filter === "open" ? ["state=open"] : []),
    ...(whose === "mine" ? ["mine=true"] : []),
  ];
  return `/api/questions${q.length ? `?${q.join("&")}` : ""}`;
}

export function QuestionList(p: {
  of: Loaded<QuestionListView>;
  current?: string;
  all?: boolean;
  mine?: boolean;
  text?: string;
  repo?: string;
  onClear?: () => void;
  /** The questions picked to answer together, and how one is picked or let go. */
  selected?: ReadonlySet<string>;
  onSelect?: (ids: string[], on: boolean) => void;
}) {
  const text = p.text ?? "";
  const pickable = (q: QuestionView) => !!p.onSelect && q.state === "open";
  const repo = p.repo ?? "";
  return (
    <View
      of={p.of}
      empty={(d) => d.questions.length === 0 && d.problems.length === 0 && !d.me}
      emptyText={p.mine ? C.emptyMine : p.all ? C.emptyAll : C.empty}
    >
      {(d) => {
        const shown = shownQuestions(d.questions, { text, repo });
        const active = !!text.trim() || !!repo;
        return (
          <div className="stack" style={{ gap: 8 }}>
            {d.me && (
              <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                {d.me.teams.length
                  ? C.mineTeams(d.me.teams.map((t) => t.name ?? t.id).join(", "))
                  : d.questions.length
                    ? C.mineChanges(d.me.handle)
                    : C.mineNone(d.me.handle)}
              </p>
            )}
            {d.me && d.me.teams.length > 0 && d.questions.length === 0 && (
              <div className="state">{C.emptyMine}</div>
            )}
            {d.problems.map((x) => (
              <p key={x.file} className="state error" role="alert" style={{ margin: 0 }}>
                {C.unreadable(x.file)} {x.message}
              </p>
            ))}
            <FilterCount shown={shown.length} total={d.questions.length} active={active} />
            {active && shown.length === 0 && d.questions.length > 0 && (
              <FilterEmpty
                what={filteredWhat({ text, repo })}
                onClear={() => p.onClear?.()}
                focus={FILTER_ID}
              />
            )}
            {shown.length > 0 &&
              byRepo(shown).map(([r, qs]) => (
                <section key={r} className="q-group" aria-label={C.groupOf(r, qs.length)}>
                  {(!repo || p.onSelect) && (
                    <h3 className="q-group-head">
                      {p.onSelect && qs.some(pickable) ? (
                        <label className="q-pick">
                          <input
                            type="checkbox"
                            checked={qs.filter(pickable).every((q) => p.selected?.has(q.id))}
                            onChange={(e) =>
                              p.onSelect!(
                                qs.filter(pickable).map((q) => q.id),
                                e.target.checked,
                              )
                            }
                            aria-label={C.bulk.pickRepo(r)}
                          />
                          <span>{r}</span>
                        </label>
                      ) : (
                        <span>{r}</span>
                      )}
                      <span className="q-count">{qs.length}</span>
                    </h3>
                  )}
                  <ul className="q-list">
                    {qs.map((q) => (
                      <li key={q.id} className="q-row">
                        {pickable(q) ? (
                          <input
                            type="checkbox"
                            className="q-check"
                            checked={!!p.selected?.has(q.id)}
                            onChange={(e) => p.onSelect!([q.id], e.target.checked)}
                            aria-label={C.bulk.pick(q.id)}
                          />
                        ) : (
                          p.onSelect && <span className="q-check-gap" aria-hidden="true" />
                        )}
                        <a
                          href={`#/questions/${q.id}`}
                          aria-current={q.id === p.current ? "true" : undefined}
                          className="q-item"
                          title={q.question}
                        >
                          <span className="q-title">{q.question}</span>
                          <span className="q-meta">
                            <span
                              className={`chip${q.state === "open" ? " warn" : q.state === "answered" ? " done" : ""}`}
                            >
                              {q.state}
                            </span>
                            <span className="mono">{q.id}</span>
                          </span>
                          {aboutWords(d.about?.[q.id]).map((w) => (
                            <span key={w} className="q-about">
                              {w}
                            </span>
                          ))}
                        </a>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
          </div>
        );
      }}
    </View>
  );
}

/** The repo of a rerun that is `atticus verify <repo> --write`, which Apply runs (ADR 0183). */
export const verifyRepoOf = (rerun: string) =>
  /^atticus verify ([a-z0-9][a-z0-9._-]*) --write$/.exec(rerun.trim())?.[1];

/** What happened after the answer was saved: the file, the skill file, the command to run next. */
export function AnsweredView({ result }: { result: AnsweredResult }) {
  return (
    <div role="status" className="stack" style={{ gap: 6 }}>
      <p style={{ margin: 0 }}>{C.saved(`questions/${result.question.id}.yaml`)}</p>
      {result.system?.added && (
        <p style={{ margin: 0 }}>{C.another.added(result.system.id, result.system.profile)}</p>
      )}
      {result.skill && (
        <p style={{ margin: 0 }}>
          {result.skill.written
            ? C.skillWritten(result.skill.path)
            : C.skillMissing(result.skill.path)}
        </p>
      )}
      <ApplyAndPropose scope="answers" repo={verifyRepoOf(result.rerun)} />
      <p style={{ margin: 0 }}>{C.next}</p>
      <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <code className="mono">{result.rerun}</code>
        <CopyButton text={result.rerun} label={C.copy} />
      </div>
    </div>
  );
}

export function QuestionDetail(p: {
  question: QuestionView;
  onAnswered: (r: AnsweredResult) => void;
  /** ADR 0144: the checked proposal for it, from the list's about. */
  proposal?: Proposal;
  /** ADR 0168: the rule that answers it and the open questions like it at once, pre-filled. */
  rule?: RuleOffer;
}) {
  const q = p.question;
  const offer = q.state === "open" ? p.rule : undefined;
  const [form, setForm] = useState<AnswerForm>({
    pick: q.answer?.option ?? (q.answer?.text ? "words" : undefined),
    text: q.answer?.text ?? "",
    scope: q.answer?.scope.level ?? q.scope.level,
    repoType: q.scope.level === "repo-type" ? q.scope.id : "",
    match: q.answer?.match ?? offer?.match ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<AnsweredResult | undefined>();
  const set = (f: Partial<AnswerForm>) => setForm((x) => ({ ...x, ...f }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const b = answerBody(form);
    if ("error" in b) {
      setError(b.error);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const r = await api<AnsweredResult>(`/api/questions/${q.id}/answer`, {
        method: "POST",
        body: b.body,
      });
      setDone(r);
      p.onAnswered(r);
    } catch (x) {
      setError(message(x));
    } finally {
      setBusy(false);
    }
  };
  const accept = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api<AnsweredResult>(`/api/questions/${q.id}/answer`, {
        method: "POST",
        body: {
          acceptProposal: true,
          scope: form.scope,
          ...(form.scope === "repo-type" && form.repoType.trim()
            ? { repoType: form.repoType.trim() }
            : {}),
          ...(form.match?.trim() ? { match: form.match.trim() } : {}),
        },
      });
      setDone(r);
      p.onAnswered(r);
    } catch (x) {
      setError(message(x));
    } finally {
      setBusy(false);
    }
  };
  const name = `q-${q.id}`;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <h2 className="h" style={{ margin: 0 }}>
        {q.question}
      </h2>
      <p className="hud" style={{ margin: 0, fontSize: 10 }}>
        {C.askedBy(q.askedBy.command, day(q.askedBy.at))} · {q.repo} ·{" "}
        <code className="mono">{q.id}</code> <CopyButton text={q.id} label={C.copyId} />
      </p>
      <div>
        <h3 className="hud" style={{ margin: "0 0 4px", fontSize: 10 }}>
          {C.evidence}
        </h3>
        <Evidence id={q.id} refs={q.evidence} />
      </div>
      {q.answer && (
        <p style={{ margin: 0 }}>
          {C.answered(q.answer.by, day(q.answer.at))}:{" "}
          {q.answer.text ?? q.options[(q.answer.option ?? 1) - 1]?.label}
          {q.answer.match ? ` · ${C.rule.answered(q.answer.match)}` : ""}
        </p>
      )}
      {q.reopened && (
        <p className="state" style={{ margin: 0 }}>
          {C.reopened(
            q.reopened.why,
            q.reopened.answer.text ?? q.options[(q.reopened.answer.option ?? 1) - 1]?.label ?? "",
            day(q.reopened.at),
          )}
        </p>
      )}
      {q.answer?.proposal && (
        <div className="stack" style={{ gap: 4 }}>
          <p className="muted" style={{ margin: 0 }}>
            {C.fromProposal(q.answer.proposal.by, day(q.answer.proposal.at))}
          </p>
          <ul style={{ margin: 0 }}>
            {q.answer.proposal.cites.map((c) => (
              <li key={`${c.repo ?? q.repo}:${c.file}:${c.line}`}>
                <span className="mono">
                  {c.repo ?? q.repo} {c.file}:{c.line}
                </span>{" "}
                <q>{c.quote}</q>
              </li>
            ))}
          </ul>
        </div>
      )}
      {q.state === "open" && p.proposal && !done && (
        <ProposalView
          question={q}
          proposal={p.proposal}
          busy={busy}
          onAccept={() => void accept()}
        />
      )}
      {q.state === "retired" ? (
        <p className="state">{C.retired}</p>
      ) : (
        <form className="stack" style={{ gap: 10 }} onSubmit={(e) => void submit(e)} noValidate>
          <fieldset className="stack" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
            <legend className="hud" style={{ fontSize: 10, marginBottom: 4 }}>
              {q.answer ? C.change : C.options}
            </legend>
            {q.options.map((o, i) => {
              const id = `${name}-o${i + 1}`;
              return (
                <div key={id} className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                  <input
                    type="radio"
                    id={id}
                    name={`${name}-pick`}
                    checked={form.pick === i + 1}
                    onChange={() =>
                      set({
                        pick: i + 1,
                        another: PICKER_OPTIONS[q.askedBy.step] === o.label,
                      })
                    }
                    aria-describedby={`${id}-d`}
                  />
                  <label htmlFor={id} className="stack" style={{ gap: 2 }}>
                    <span>
                      {i + 1}. {o.label}
                    </span>
                    <span id={`${id}-d`} className="muted" style={{ fontSize: 12 }}>
                      {sentence(o.means)} {C.optionChanges}: {sentence(o.changes)}
                    </span>
                  </label>
                </div>
              );
            })}
            {form.another && <TargetPicker id={q.id} form={form} set={set} />}
            <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
              <input
                type="radio"
                id={`${name}-words`}
                name={`${name}-pick`}
                checked={form.pick === "words"}
                onChange={() => set({ pick: "words", another: false })}
              />
              <label htmlFor={`${name}-words`}>{C.ownWords}</label>
            </div>
            {form.pick === "words" && (
              <div className="stack" style={{ gap: 4 }}>
                <label htmlFor={`${name}-text`} className="hud" style={{ fontSize: 10 }}>
                  {C.ownWordsLabel}
                </label>
                <textarea
                  id={`${name}-text`}
                  className="field"
                  rows={3}
                  value={form.text}
                  onChange={(e) => set({ text: e.target.value })}
                />
              </div>
            )}
          </fieldset>
          <fieldset className="stack" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
            <legend className="hud" style={{ fontSize: 10, marginBottom: 4 }}>
              {C.scope}
            </legend>
            <div className="row" style={{ gap: 8 }}>
              <input
                type="radio"
                id={`${name}-repo`}
                name={`${name}-scope`}
                checked={form.scope === "repo"}
                onChange={() => set({ scope: "repo" })}
              />
              <label htmlFor={`${name}-repo`}>
                {C.scopeRepo(q.repo)}
                {q.scope.level === "repo" ? ` (${C.proposed})` : ""}
              </label>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <input
                type="radio"
                id={`${name}-type`}
                name={`${name}-scope`}
                checked={form.scope === "repo-type"}
                onChange={() => set({ scope: "repo-type" })}
              />
              <label htmlFor={`${name}-type`}>
                {q.scope.level === "repo-type"
                  ? `${C.scopeType(q.scope.id)} (${C.proposed})`
                  : C.scopeTypeOther}
              </label>
            </div>
            {form.scope === "repo-type" && q.scope.level !== "repo-type" && (
              <div className="stack" style={{ gap: 4 }}>
                <label htmlFor={`${name}-type-id`} className="hud" style={{ fontSize: 10 }}>
                  {C.typeLabel}
                </label>
                <input
                  id={`${name}-type-id`}
                  className="field"
                  value={form.repoType}
                  onChange={(e) => set({ repoType: e.target.value })}
                />
              </div>
            )}
          </fieldset>
          {RULE_STEPS.has(q.askedBy.step) && (
            <div className="stack" style={{ gap: 4 }}>
              <label htmlFor={`${name}-match`} className="hud" style={{ fontSize: 10 }}>
                {C.rule.label}
              </label>
              <input
                id={`${name}-match`}
                className="field mono"
                value={form.match ?? ""}
                aria-describedby={`${name}-match-d`}
                onChange={(e) => set({ match: e.target.value })}
              />
              <span id={`${name}-match-d`} className="muted" style={{ fontSize: 12 }}>
                {offer ? `${C.rule.offer(offer.ids.length, offer.calls, offer.match)} ` : ""}
                {C.rule.hint}
              </span>
            </div>
          )}
          {error && (
            <p role="alert" className="state error" style={{ margin: 0 }}>
              {error}
            </p>
          )}
          <div>
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? C.saving : C.submit}
            </button>
          </div>
        </form>
      )}
      {done && <AnsweredView result={done} />}
    </div>
  );
}

function Detail({
  id,
  onAnswered,
  proposal,
  rule,
}: {
  id: string;
  onAnswered: () => void;
  proposal?: Proposal;
  rule?: RuleOffer;
}) {
  const q = useApi<QuestionView>(`/api/questions/${id}`);
  useReloadOnFiles(q);
  const heading = useRef<HTMLDivElement>(null);
  // Move focus to the question when it opens from the list, for keyboard and screen reader users.
  useEffect(() => {
    if (q.state === "ready") heading.current?.focus();
  }, [q.state, id]);
  return (
    <div ref={heading} tabIndex={-1}>
      <View of={q}>
        {(d) => (
          <QuestionDetail
            key={d.id}
            question={d}
            onAnswered={onAnswered}
            {...(proposal ? { proposal } : {})}
            {...(rule ? { rule } : {})}
          />
        )}
      </View>
    </div>
  );
}

/** The body that answers each of several questions the same way: a target, or the same words. */
export function bulkBody(f: {
  how: "target" | "words";
  value: string;
}): { body: Record<string, unknown> } | { error: string } {
  const v = f.value.trim();
  if (!v) return { error: f.how === "target" ? C.bulk.needTarget : C.needWords };
  return { body: f.how === "target" ? { target: v, scope: "repo" } : { text: v, scope: "repo" } };
}

/**
 * Several open questions answered the same way (beta.14): where their calls go (a repo, system or
 * team, the first question's picks offered), or the same words. Each is answered on its own, as
 * one answer would be; what failed says why, and the rest stand.
 */
export function BulkAnswer(p: {
  ids: string[];
  questions: QuestionView[];
  onDone: (answered: string[]) => void;
  onClear: () => void;
}) {
  const targetsOnly = p.questions.every((q) => q.askedBy.step === "facts-targets");
  const [how, setHow] = useState<"target" | "words">(targetsOnly ? "target" : "words");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [result, setResult] = useState<{ ok: string[]; failed: { id: string; why: string }[] }>();
  const picks = useApi<Api.TargetPickListT>(`/api/questions/${p.ids[0]}/targets`);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const b = bulkBody({ how, value });
    if ("error" in b) {
      setError(b.error);
      return;
    }
    setBusy(true);
    setError(undefined);
    const ok: string[] = [];
    const failed: { id: string; why: string }[] = [];
    for (const id of p.ids) {
      try {
        await api<AnsweredResult>(`/api/questions/${id}/answer`, { method: "POST", body: b.body });
        ok.push(id);
      } catch (x) {
        failed.push({ id, why: message(x) });
      }
    }
    setBusy(false);
    setResult({ ok, failed });
    p.onDone(ok);
  };
  return (
    <form className="stack" style={{ gap: 10 }} onSubmit={(e) => void submit(e)} noValidate>
      <h2 className="h" style={{ margin: 0 }}>
        {C.bulk.title(p.ids.length)}
      </h2>
      <ul className="q-bulk-list">
        {p.questions.slice(0, 8).map((q) => (
          <li key={q.id}>
            <span className="mono">{q.id}</span> {q.question}
          </li>
        ))}
        {p.questions.length > 8 && <li className="muted">{C.bulk.more(p.questions.length - 8)}</li>}
      </ul>
      {targetsOnly && (
        <Choice
          label={C.bulk.how}
          value={how}
          options={[
            { value: "target", label: C.bulk.byTarget },
            { value: "words", label: C.bulk.byWords },
          ]}
          onChange={setHow}
        />
      )}
      <label htmlFor="bulk-value" className="hud" style={{ fontSize: 10 }}>
        {how === "target" ? C.bulk.targetLabel : C.ownWords}
      </label>
      <input
        id="bulk-value"
        className="field"
        list={how === "target" ? "bulk-picks" : undefined}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-describedby="bulk-hint"
      />
      {how === "target" && picks.state === "ready" && (
        <datalist id="bulk-picks">
          {picks.data.picks.map((x) => (
            <option key={`${x.kind}:${x.id}`} value={x.id}>
              {x.name} ({x.kind})
            </option>
          ))}
        </datalist>
      )}
      <span id="bulk-hint" className="muted" style={{ fontSize: 12 }}>
        {C.bulk.hint}
      </span>
      {error && (
        <p role="alert" className="state error" style={{ margin: 0 }}>
          {error}
        </p>
      )}
      {result && (
        <div role="status" className="stack" style={{ gap: 4 }}>
          <p className="state" style={{ margin: 0 }}>
            {C.bulk.done(result.ok.length)}
          </p>
          {result.failed.map((f) => (
            <p key={f.id} className="state error" style={{ margin: 0 }}>
              {f.id}: {f.why}
            </p>
          ))}
          {result.ok.length > 0 && <code className="mono">{C.bulk.next}</code>}
        </div>
      )}
      <div className="row" style={{ gap: 8 }}>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? C.bulk.busy : C.bulk.submit(p.ids.length)}
        </button>
        <button type="button" className="btn" onClick={p.onClear} disabled={busy}>
          {C.bulk.clear}
        </button>
      </div>
    </form>
  );
}

/** How many questions are open, answered and retired, in one repo when one is picked. */
export function questionCounts(qs: QuestionView[], repo = "") {
  const mine = repo ? qs.filter((q) => q.repo === repo) : qs;
  const n = (state: string) => mine.filter((q) => q.state === state).length;
  return {
    open: n("open"),
    answered: n("answered"),
    retired: n("retired"),
    total: mine.length,
    repos: questionRepos(mine).length,
  };
}

/**
 * beta.21: the counts for the top of the page from the one list request: the server's, by state,
 * for the whole estate; a picked repo's from the questions listed.
 */
export function countsOf(d: QuestionListView, repo = "") {
  if (!d.counts) return questionCounts(d.questions, repo);
  const by = d.counts.byRepo ?? {};
  if (repo) {
    const c = by[repo] ?? { open: 0, answered: 0, retired: 0, total: 0 };
    return { ...c, repos: 1 };
  }
  const { byRepo: _by, ...all } = d.counts;
  return { ...all, repos: Object.keys(by).length };
}

/** The counts at the top of the page; Open and All pick the list's filter. */
export function QuestionCounts(p: {
  counts: ReturnType<typeof questionCounts>;
  repo?: string;
  filter: "open" | "all";
  onFilter: (f: "open" | "all") => void;
}) {
  const c = p.counts;
  const done = c.total ? Math.round(((c.answered + c.retired) / c.total) * 100) : 0;
  const tile = (label: string, n: number, tone: string, pick?: "open" | "all") => (
    <button
      type="button"
      className={`q-stat ${tone}`}
      aria-pressed={pick ? p.filter === pick : undefined}
      disabled={!pick}
      onClick={() => pick && p.onFilter(pick)}
    >
      <span className="q-stat-n">{n}</span>
      <span className="q-stat-label">{label}</span>
    </button>
  );
  return (
    <div className="q-stats" role="group" aria-label={C.counts.label(p.repo)}>
      {tile(C.counts.open, c.open, "warn", "open")}
      {tile(C.counts.answered, c.answered, "done")}
      {tile(C.counts.retired, c.retired, "")}
      {tile(C.counts.total, c.total, "", "all")}
      <div className="q-progress" aria-label={C.counts.progress(done)}>
        <div className="q-progress-bar">
          <span style={{ width: `${done}%` }} />
        </div>
        <span className="muted">
          {C.counts.progress(done)}
          {p.repo ? "" : ` · ${C.counts.repos(c.repos)}`}
        </span>
      </div>
    </div>
  );
}

export function Questions({ hash }: { hash: string }) {
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [whose, setWhose] = useState<"all" | "mine">("all");
  const list = useApi<QuestionListView>(questionsUrl(filter, whose));
  // UX review (2026-11-08): the knowledge gaps' owner questions, the ones Home counts too.
  const owner = useApi<Api.OwnerQuestionListT>("/api/owner-questions");
  useReloadOnFiles(list, owner);
  const [kind, setKind] = useState<QuestionsKind>(questionsKind(hash));
  useEffect(() => setKind(questionsKind(hash)), [hash]);

  const current = questionRoute(hash);
  const [text, setText] = useState("");
  const [repo, setRepo] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const select = (ids: string[], on: boolean) =>
    setSelected((x) => {
      const n = new Set(x);
      for (const id of ids)
        if (on) n.add(id);
        else n.delete(id);
      return n;
    });
  const picked =
    list.state === "ready" ? list.data.questions.filter((q) => selected.has(q.id)) : [];
  const repos = [
    ...new Set([
      ...(list.state === "ready" ? questionRepos(list.data.questions) : []),
      ...(repo ? [repo] : []),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  return (
    <>
      <div className="row between" style={{ flexWrap: "wrap" }}>
        <p className="n" style={{ margin: 0, fontSize: 24 }}>
          {C.title}
        </p>
        <Choice
          label={C.kind}
          value={kind}
          options={[
            {
              value: "steps",
              label: C.kindSteps(list.state === "ready" ? countsOf(list.data).open : undefined),
            },
            {
              value: "owner",
              label: C.kindOwner(owner.state === "ready" ? owner.data.open : undefined),
            },
          ]}
          onChange={setKind}
        />
      </div>
      {kind === "owner" ? (
        <>
          <p className="muted" style={{ margin: "4px 0 12px", fontSize: 12.5, lineHeight: 1.55 }}>
            {C.ownerQuestions.intro}
          </p>
          <section className="stack" aria-label={C.ownerQuestions.title}>
            <OwnerQuestionList of={owner} onAnswered={owner.reload} />
          </section>
        </>
      ) : (
        <>
          <div className="row" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
              <FilterBox id={FILTER_ID} value={text} onChange={setText} />
              <div className="stack" style={{ gap: 4 }}>
                <label htmlFor="questions-repo" className="hud" style={{ fontSize: 10 }}>
                  {COPY.filter.repo}
                </label>
                <select
                  id="questions-repo"
                  className="field"
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                >
                  <option value="">{COPY.filter.allRepos}</option>
                  {repos.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              <Choice
                label={C.whose}
                value={whose}
                options={[
                  { value: "all", label: C.whoseAll },
                  { value: "mine", label: C.whoseMine },
                ]}
                onChange={setWhose}
              />
              <Choice
                label={C.filter}
                value={filter}
                options={[
                  { value: "open", label: C.filterOpen },
                  { value: "all", label: C.filterAll },
                ]}
                onChange={setFilter}
              />
            </div>
          </div>
          <p className="muted" style={{ margin: "4px 0 12px", fontSize: 12.5, lineHeight: 1.55 }}>
            {C.intro}
          </p>
          {list.state === "ready" && (
            <QuestionCounts
              counts={countsOf(list.data, repo)}
              {...(repo ? { repo } : {})}
              filter={filter}
              onFilter={setFilter}
            />
          )}
          <div className="bento">
            <Panel title={C.listTitle} span="span 5">
              <QuestionList
                of={list}
                current={current}
                all={filter === "all"}
                mine={whose === "mine"}
                text={text}
                repo={repo}
                onClear={() => {
                  setText("");
                  setRepo("");
                }}
                selected={selected}
                onSelect={select}
              />
            </Panel>
            <section className="panel" style={{ gridColumn: "span 7" }}>
              {picked.length > 0 ? (
                <BulkAnswer
                  key={picked.map((q) => q.id).join(",")}
                  ids={picked.map((q) => q.id)}
                  questions={picked}
                  onDone={() => list.reload()}
                  onClear={() => setSelected(new Set())}
                />
              ) : current ? (
                <Detail
                  id={current}
                  onAnswered={list.reload}
                  {...(list.state === "ready" && list.data.about?.[current]?.proposal
                    ? { proposal: list.data.about[current].proposal }
                    : {})}
                  {...(list.state === "ready" && list.data.about?.[current]?.rule
                    ? { rule: list.data.about[current].rule }
                    : {})}
                />
              ) : (
                <div className="state">{C.pickFromList}</div>
              )}
            </section>
          </div>
        </>
      )}
    </>
  );
}
