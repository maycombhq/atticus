import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Question } from "@maycombhq/core";
import { api, useApi, useReloadOnFiles, type Loaded } from "../api/client.js";
import { Panel, View } from "../app/ui.js";
import { COPY } from "../copy.js";
import { Choice, CopyButton, message } from "./run/shared.js";
import { FilterBox, FilterCount, FilterEmpty, filteredWhat, matchesWords } from "../app/filter.js";

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
}
export interface AnsweredResult {
  question: QuestionView;
  rerun: string;
  skill?: { path: string; written: boolean };
}

const ID = /^q-[0-9a-f]{12}$/;

/** The question id in #/questions/<id>, if any. */
export function questionRoute(hash: string): string | undefined {
  const id = decodeURIComponent(hash.replace(/^#\/?/, "").split(/[?]/)[0]!.split("/")[1] ?? "");
  return ID.test(id) ? id : undefined;
}

export interface AnswerForm {
  /** An option number, or "words" for the person's own words; undefined until picked. */
  pick: number | "words" | undefined;
  text: string;
  scope: "repo" | "repo-type";
  repoType: string;
}

/** The POST body for the form, or what is missing in words. */
export function answerBody(f: AnswerForm): { body: Record<string, unknown> } | { error: string } {
  if (f.pick === undefined) return { error: C.pickOne };
  const what =
    f.pick === "words" ? (f.text.trim() ? { text: f.text.trim() } : undefined) : { option: f.pick };
  if (!what) return { error: C.needWords };
  if (f.scope === "repo-type") {
    if (!f.repoType.trim()) return { error: C.needType };
    return { body: { ...what, scope: "repo-type", repoType: f.repoType.trim() } };
  }
  return { body: { ...what, scope: "repo" } };
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

export function QuestionList(p: {
  of: Loaded<QuestionListView>;
  current?: string;
  all?: boolean;
  text?: string;
  repo?: string;
  onClear?: () => void;
}) {
  const text = p.text ?? "";
  const repo = p.repo ?? "";
  return (
    <View
      of={p.of}
      empty={(d) => d.questions.length === 0 && d.problems.length === 0}
      emptyText={p.all ? C.emptyAll : C.empty}
    >
      {(d) => {
        const shown = shownQuestions(d.questions, { text, repo });
        const active = !!text.trim() || !!repo;
        return (
          <div className="stack" style={{ gap: 8 }}>
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
            {shown.length > 0 && (
              <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0, gap: 6 }}>
                {shown.map((q) => (
                  <li key={q.id}>
                    <a
                      href={`#/questions/${q.id}`}
                      aria-current={q.id === p.current ? "true" : undefined}
                      className="stack"
                      style={{ gap: 2 }}
                    >
                      <span>{q.question}</span>
                      <span className="hud" style={{ fontSize: 10 }}>
                        {q.repo} · {q.state} · {q.id}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      }}
    </View>
  );
}

/** What happened after the answer was saved: the file, the skill file, the command to run next. */
export function AnsweredView({ result }: { result: AnsweredResult }) {
  return (
    <div role="status" className="stack" style={{ gap: 6 }}>
      <p style={{ margin: 0 }}>{C.saved(`questions/${result.question.id}.yaml`)}</p>
      {result.skill && (
        <p style={{ margin: 0 }}>
          {result.skill.written
            ? C.skillWritten(result.skill.path)
            : C.skillMissing(result.skill.path)}
        </p>
      )}
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
}) {
  const q = p.question;
  const [form, setForm] = useState<AnswerForm>({
    pick: q.answer?.option ?? (q.answer?.text ? "words" : undefined),
    text: q.answer?.text ?? "",
    scope: q.answer?.scope.level ?? q.scope.level,
    repoType: q.scope.level === "repo-type" ? q.scope.id : "",
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
  const name = `q-${q.id}`;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <h2 className="h" style={{ margin: 0 }}>
        {q.question}
      </h2>
      <p className="hud" style={{ margin: 0, fontSize: 10 }}>
        {C.askedBy(q.askedBy.command, day(q.askedBy.at))} · {q.repo}
      </p>
      <div>
        <h3 className="hud" style={{ margin: "0 0 4px", fontSize: 10 }}>
          {C.evidence}
        </h3>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {q.evidence.map((e) => (
            <li key={e}>
              <code className="mono">{e}</code>
            </li>
          ))}
        </ul>
      </div>
      {q.answer && (
        <p style={{ margin: 0 }}>
          {C.answered(q.answer.by, day(q.answer.at))}:{" "}
          {q.answer.text ?? q.options[(q.answer.option ?? 1) - 1]?.label}
        </p>
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
                    onChange={() => set({ pick: i + 1 })}
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
            <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
              <input
                type="radio"
                id={`${name}-words`}
                name={`${name}-pick`}
                checked={form.pick === "words"}
                onChange={() => set({ pick: "words" })}
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

function Detail({ id, onAnswered }: { id: string; onAnswered: () => void }) {
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
        {(d) => <QuestionDetail key={d.id} question={d} onAnswered={onAnswered} />}
      </View>
    </div>
  );
}

export function Questions({ hash }: { hash: string }) {
  const [filter, setFilter] = useState<"open" | "all">("open");
  const list = useApi<QuestionListView>(
    filter === "open" ? "/api/questions?state=open" : "/api/questions",
  );
  useReloadOnFiles(list);
  const current = questionRoute(hash);
  const [text, setText] = useState("");
  const [repo, setRepo] = useState("");
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
      <div className="bento">
        <Panel title={C.listTitle} span="span 5">
          <QuestionList
            of={list}
            current={current}
            all={filter === "all"}
            text={text}
            repo={repo}
            onClear={() => {
              setText("");
              setRepo("");
            }}
          />
        </Panel>
        <section className="panel" style={{ gridColumn: "span 7" }}>
          {current ? (
            <Detail id={current} onAnswered={list.reload} />
          ) : (
            <div className="state">{C.pickFromList}</div>
          )}
        </section>
      </div>
    </>
  );
}
