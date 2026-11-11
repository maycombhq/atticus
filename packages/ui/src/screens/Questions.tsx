import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { ApplyAndPropose } from "../app/propose.js";
import { RunStep, stepArgs } from "../app/runstep.js";
import type { Api, Question } from "@maycombhq/core";
import { api, callAsJob, useApi, useReloadOnFiles, type Loaded } from "../api/client.js";
import { View } from "../app/ui.js";
import { useAvailableHeight } from "../app/viewer.js";
import { COPY } from "../copy.js";
import { Choice, CopyButton, message } from "./run/shared.js";
import { FilterBox, FilterCount, FilterEmpty, filteredWhat, matchesWords } from "../app/filter.js";
import { OwnerQuestionList, questionsKind, type QuestionsKind } from "./OwnerQuestions.js";
import { queryParam } from "./know/common.js";
import { RoleFilter, roleScopeOf, scopeWithRole, withRoleScope } from "./RoleQuestions.js";
import { AiChip, AiMark, isAiBy, readyView, SplitCounts, useDecisions } from "../app/decisions.js";
import { RouteQuestion } from "./RouteQuestion.js";
import {
  questionsToAnswerOf,
  STEP_QUESTIONS_PATH,
  type QuestionsToAnswer,
  type StepQuestionsAnswer,
} from "../app/question-counts.js";
import { useKnownAnswer } from "../app/shell/explorer-data.js";
import "./questions.css";

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
  /** ADR 0181 part 4: with change=, the person's roles on it. */
  yourRoles?: Api.QuestionListT["yourRoles"];
}

type About = NonNullable<Api.QuestionListT["about"]>[string];

/**
 * Ninth UX walk: the role a question is for, in words ("For the architect"), from the list's
 * about (derived for an older file) or the question's own; undefined where no role owns it.
 */
export function roleWords(role: string | undefined): string | undefined {
  if (!role) return undefined;
  return C.forRole(COPY.roles.who[role] ?? role);
}

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
    <section aria-labelledby={head} className="qs-section qs-proposal">
      <h3 id={head} className="qs-label">
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
      <h4 className="qs-label">{P.cites}</h4>
      <ul className="qs-cites">
        {x.cites.map((c) => (
          <li key={`${c.repo ?? q.repo}:${c.file}:${c.line}`}>
            <span className="mono">
              {c.repo ?? q.repo} {c.file}:{c.line}
            </span>{" "}
            <q>{c.quote}</q>
          </li>
        ))}
      </ul>
      <div className="qs-group-btns">
        <button type="button" className="btn primary" disabled={p.busy} onClick={p.onAccept}>
          {p.busy ? P.accepting : P.accept}
        </button>
        <code className="mono qs-cmd">{P.command(q.id)}</code>
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
    <div className="qs-sub">
      <label htmlFor={`${name}-pick`} className="qs-label">
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
      <label htmlFor={`${name}-new`} className="qs-label">
        {A.newVendor}
      </label>
      <input
        id={`${name}-new`}
        className="field"
        value={typed}
        aria-describedby={`${name}-new-d`}
        onChange={(e) => pickTo(undefined, e.target.value)}
      />
      <span id={`${name}-new-d`} className="qs-hint">
        {A.newVendorHint}
      </span>
      {p.form.needsSystem && (
        <div className="qs-check">
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
    <figure className="qs-excerpt">
      <figcaption>
        <code className="mono">{e.ref}</code>
        {!e.found && <span className="muted">{C.notShown}</span>}
      </figcaption>
      {e.found && (
        <pre
          className="mono qs-code"
          // UX re-walk (axe): a code excerpt that scrolls can be reached and scrolled by keyboard.
          tabIndex={0}
          role="region"
          aria-label={C.excerptOf(e.ref)}
        >
          {e.lines.map((l, i) => {
            const n = e.start + i;
            const cited = n === e.line;
            // Beta.27: a long line wraps under itself, its number kept in its own column, so the
            // cited line is read whole (it ran past the box's right edge).
            return (
              <span key={n} className="qs-line" aria-current={cited ? "true" : undefined}>
                <span className="muted qs-ln">{`${String(n).padStart(4)}  `}</span>
                <span className="qs-lc">{cited ? <mark>{l}</mark> : l}</span>
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
      <ul className="qs-refs">
        {refs.map((e) => (
          <li key={e}>
            <code className="mono">{e}</code>
          </li>
        ))}
      </ul>
    );
  return (
    <div className="qs-excerpts">
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
  /**
   * An option number, "words" for the person's own words, or (beta.24 review) "ignore" for
   * Ignore; undefined until picked.
   */
  pick: number | "words" | "ignore" | undefined;
  /** Beta.24 review: why the calls aren't real, with Ignore (optional). */
  reason?: string;
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

/**
 * Beta.24 review: the questions about where calls go (hosts, targets, topics, the estate's
 * call-outs), each of which takes Ignore, as the core's JOIN_STEPS.
 */
export const JOIN_STEP_IDS: ReadonlySet<string> = new Set([
  "scan-hosts",
  "facts-targets",
  "facts-topics",
  "estate-targets",
]);
/** The Ignore option, as the core's JOIN_IGNORE_LABEL: its words are the copy file's. */
export const IGNORE_LABEL = C.ignore.label;

/** Whether an answer is Ignore (its option, or words that start `Ignore:`), and its reason. */
export function ignoredOf(q: {
  options: readonly { label: string }[];
  answer?: { option?: number; text?: string } | undefined;
}): { reason?: string } | undefined {
  const a = q.answer;
  if (!a) return undefined;
  if (a.option !== undefined)
    return q.options[a.option - 1]?.label === IGNORE_LABEL ? {} : undefined;
  const t = a.text?.trim() ?? "";
  if (!/^ignore:/i.test(t)) return undefined;
  const reason = t === IGNORE_LABEL ? "" : t.slice("Ignore:".length).trim();
  return reason ? { reason } : {};
}

/** The steps whose answers take a rule (ADR 0153): where calls go, by target or by host. */
export const RULE_STEPS: ReadonlySet<string> = new Set(["facts-targets", "scan-hosts"]);

/** The POST body for the form, or what is missing in words. */
export function answerBody(f: AnswerForm): { body: Record<string, unknown> } | { error: string } {
  if (f.pick === undefined) return { error: C.pickOne };
  const rule0 = f.match?.trim() ? { match: f.match.trim() } : {};
  // Beta.24 review: Ignore, with its reason when one is given.
  if (f.pick === "ignore") {
    const why = f.reason?.trim() ? { reason: f.reason.trim() } : {};
    if (f.scope === "repo-type") {
      if (!f.repoType.trim()) return { error: C.needType };
      return {
        body: { ignore: true, ...why, scope: "repo-type", repoType: f.repoType.trim(), ...rule0 },
      };
    }
    return { body: { ignore: true, ...why, scope: "repo", ...rule0 } };
  }
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
  /** Eighth UX walk: the change the page is opened for; a question's link keeps it. */
  change?: string | undefined;
  /** Review round 46: the role the list is filtered to; a question's link keeps it too. */
  role?: string | undefined;
}) {
  const text = p.text ?? "";
  const pickable = (q: QuestionView) => !!p.onSelect && q.state === "open";
  const repo = p.repo ?? "";
  return (
    <View
      of={p.of}
      empty={(d) => d.questions.length === 0 && d.problems.length === 0 && !d.me}
      emptyText={
        // Ninth UX walk: a change's empty list is the change's, not a scan's.
        p.change
          ? p.all
            ? C.emptyChangeAll(p.change)
            : C.emptyChange(p.change)
          : p.mine
            ? C.emptyMine
            : p.all
              ? C.emptyAll
              : C.empty
      }
    >
      {(d) => {
        const shown = shownQuestions(d.questions, { text, repo });
        const active = !!text.trim() || !!repo;
        return (
          <div className="stack" style={{ gap: 8 }}>
            {d.me && (
              <p className="qs-note">
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
                          href={withRoleScope(`#/questions/${q.id}`, {
                            ...(p.change ? { change: p.change } : {}),
                            ...(p.role ? { role: p.role } : {}),
                          })}
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
                            {roleWords(d.about?.[q.id]?.role ?? q.role) && (
                              <span className="chip">
                                {roleWords(d.about?.[q.id]?.role ?? q.role)}
                              </span>
                            )}
                            {q.answer && isAiBy(q.answer.by) && <AiChip inLink />}
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

/**
 * ADR 0188: the repo an answer is applied to: a rerun of `atticus verify <repo> --write`, or of
 * the read that asked it (`atticus map <repo>`), whose answers Apply puts on the map without
 * reading the repo again.
 */
export const applyRepoOf = (rerun: string) =>
  verifyRepoOf(rerun) ?? /^atticus map ([a-z0-9][a-z0-9._-]*)$/.exec(rerun.trim())?.[1];

/**
 * Seventh UX walk: when a question was asked, in words. The app never shows the command that
 * asked it (`atticus verify <repo> --write`); the command stays in the question's file.
 */
export function askedByWords(by: { step: string; command: string }, at: string): string {
  const cmd = by.command.trim();
  const verify = /^atticus verify ([a-z0-9][a-z0-9._-]*)/.exec(cmd)?.[1];
  if (verify) return C.askedWhen.verify(verify, at);
  const stage = /^atticus change ([a-z-]+) ([a-z0-9][a-z0-9._-]*)/.exec(cmd);
  if (stage) return C.askedWhen.stage(stage[1]!, stage[2]!, at);
  const words = cmd.split(/\s+/).filter((w) => !w.startsWith("-"));
  if (/^atticus (scan|map|onboard)\b/.test(cmd) && words.length > 2)
    return C.askedWhen.read(words.at(-1)!, at);
  return C.askedWhen.step(by.step, at);
}

/**
 * Seventh UX walk: what an option changes, said for the app. The step wrote it with the command
 * that applies it, in brackets; on this page Apply does that, so the words say so instead.
 */
export function changesInWords(text: string): string {
  return text
    .replace(
      /when the facts are next written \(atticus verify ([a-z0-9][a-z0-9._-]*) --write\)/g,
      (_m, repo: string) => C.whenApplied(repo),
    )
    .replace(
      /atticus questions answer <id> --target <[^>]*> lists them and takes the one you name \(the app's Questions page lists them too\)/g,
      C.pickBelow,
    )
    .replace(/\s*\((?:atticus [^)]*|\/atticus-[^)]*)\)/g, "");
}

/**
 * Seventh UX walk: Apply beside an answered map question while its repo's answers aren't in the
 * map yet (the server's applyFirst), so leaving the page never loses the step. Nothing otherwise.
 */
export function ApplyPending({ repo, file }: { repo: string; file?: string }) {
  const plan = useApi<{ applyFirst?: string[]; files?: { path: string; proposed?: string }[] }>(
    "/api/propose?scope=work",
  );
  if (plan.state !== "ready") return null;
  if (plan.data.applyFirst?.includes(repo))
    return (
      <div className="stack" style={{ gap: 4 }}>
        <p className="work-say" style={{ margin: 0 }}>
          {C.notApplied}
        </p>
        <ApplyAndPropose scope="answers" repo={repo} />
      </div>
    );
  // ADR 0188: applied, but its file isn't proposed yet: Propose stays on the question.
  const waiting = file && plan.data.files?.some((f) => f.path === file && !f.proposed);
  if (!waiting) return null;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <p className="work-say" style={{ margin: 0 }}>
        {C.notProposed}
      </p>
      <ApplyAndPropose scope="answers" />
    </div>
  );
}

/** Focus moves to the note when it shows (WCAG 2.4.3): saving by keyboard never loses it. */
const focusOnShow = (el: HTMLElement | null) => el?.focus();

/** A question a change's stage asked, filed under the change's id (sixth UX walk). */
export const isChangeQuestion = (q: QuestionView) => {
  const words = (q.askedBy?.command ?? "").trim().split(/\s+/);
  return /^atticus (change|plan) /.test(q.askedBy?.command ?? "") && words.includes(q.repo);
};

/**
 * Eighth UX walk: a command is a step of a change (`atticus change <step> <id>`, `atticus plan
 * <step> <id>`, `atticus critic <id>`), and of the change `id` when one is given: the rule of
 * namesChange in packages/changes/src/handoff.ts, which a hand-off reads its questions by.
 */
export function namesChange(command: string | undefined, id?: string): boolean {
  const w = (command ?? "").trim().split(/\s+/);
  if (w[0] !== "atticus") return false;
  if (w[1] !== "change" && w[1] !== "plan" && w[1] !== "critic") return false;
  return id === undefined ? w.length > 2 : w.slice(2).includes(id);
}

/** The questions a change's steps asked: the step that asked it, or the one its answer reruns. */
export const askedForChange = (q: QuestionView, id: string) =>
  namesChange(q.askedBy?.command, id) || namesChange(q.rerun, id);

/** A question about the map (a repo's read), not one a change's step asked. */
export const isMapQuestion = (q: QuestionView) =>
  !namesChange(q.askedBy?.command) && !namesChange(q.rerun);

/** What happened after the answer was saved: the file, the skill file, the command to run next. */
export function AnsweredView({ result }: { result: AnsweredResult }) {
  return (
    <div role="status" ref={focusOnShow} tabIndex={-1} className="qs-done">
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
      {/* Sixth UX walk: what to do next is in the app first, the command after it. */}
      {/* ADR 0188: an answer to a read's question is applied (verify --write), not read again. */}
      {applyRepoOf(result.rerun) || !stepArgs(result.rerun) ? (
        <>
          <p style={{ margin: 0 }}>{C.next}</p>
          <ApplyAndPropose scope="answers" repo={applyRepoOf(result.rerun)} />
        </>
      ) : (
        <>
          <p style={{ margin: 0 }}>{C.nextStage}</p>
          <RunStep command={result.rerun} />
        </>
      )}
      <details className="work-terminal">
        <summary>{C.orCommandLine}</summary>
        <div className="work-cmd">
          <code className="mono">{result.rerun}</code>
          <CopyButton text={result.rerun} label={C.copy} />
        </div>
      </details>
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
  /** Ninth UX walk: the role it is for, from the list's about (derived for an older file). */
  role?: string;
  /** ADR 0191: what it asks (business, design, delivery), from the list's about. */
  asks?: string;
  /** ADR 0191: told when a person sent it to another role. */
  onRouted?: () => void;
}) {
  const q = p.question;
  const forRole = roleWords(p.role ?? q.role);
  const offer = q.state === "open" ? p.rule : undefined;
  const ignored = ignoredOf(q);
  const joinStep = JOIN_STEP_IDS.has(q.askedBy.step);
  const [form, setForm] = useState<AnswerForm>({
    pick: ignored ? "ignore" : (q.answer?.option ?? (q.answer?.text ? "words" : undefined)),
    text: ignored ? "" : (q.answer?.text ?? ""),
    ...(ignored?.reason ? { reason: ignored.reason } : {}),
    scope: q.answer?.scope.level ?? q.scope.level,
    repoType: q.scope.level === "repo-type" ? q.scope.id : "",
    match: q.answer?.match ?? offer?.match ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<AnsweredResult | undefined>();
  // ADR 0181: Correct stays open, with its result, after the answer becomes the person's.
  const [correcting, setCorrecting] = useState(false);
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
  const folded = !!q.answer && !done;
  const answerForm = (
    <form className="qs-form" onSubmit={(e) => void submit(e)} noValidate>
      <fieldset className="qs-section">
        <legend>{q.answer && !folded ? C.change : C.options}</legend>
        <div className="qs-opts">
          {q.options.map((o, i) => {
            const id = `${name}-o${i + 1}`;
            // Beta.24 review: Ignore is offered below, with its reason, for every join question.
            if (joinStep && o.label === IGNORE_LABEL) return null;
            const picker = PICKER_OPTIONS[q.askedBy.step] === o.label;
            return (
              <Fragment key={id}>
                <div className="qs-opt">
                  <input
                    type="radio"
                    id={id}
                    name={`${name}-pick`}
                    checked={form.pick === i + 1}
                    onChange={() => set({ pick: i + 1, another: picker })}
                    aria-describedby={`${id}-d`}
                  />
                  <label htmlFor={id}>
                    <span className="qs-opt-label">
                      <span className="qs-opt-num">{i + 1}.</span> {o.label}
                    </span>
                    <span id={`${id}-d`} className="qs-opt-d">
                      {sentence(o.means)} {C.optionChanges}: {sentence(changesInWords(o.changes))}
                    </span>
                  </label>
                </div>
                {picker && form.another && <TargetPicker id={q.id} form={form} set={set} />}
              </Fragment>
            );
          })}
          {joinStep && (
            <div className="qs-opt">
              <input
                type="radio"
                id={`${name}-ignore`}
                name={`${name}-pick`}
                checked={form.pick === "ignore"}
                onChange={() => set({ pick: "ignore", another: false })}
                aria-describedby={`${name}-ignore-d`}
              />
              <label htmlFor={`${name}-ignore`}>
                <span className="qs-opt-label">{IGNORE_LABEL}</span>
                <span id={`${name}-ignore-d`} className="qs-opt-d">
                  {C.ignore.means}
                </span>
              </label>
            </div>
          )}
          {form.pick === "ignore" && (
            <div className="qs-sub">
              <label htmlFor={`${name}-reason`} className="qs-label">
                {C.ignore.reason}
              </label>
              <input
                id={`${name}-reason`}
                className="field"
                maxLength={300}
                value={form.reason ?? ""}
                onChange={(e) => set({ reason: e.target.value })}
              />
            </div>
          )}
          <div className="qs-opt">
            <input
              type="radio"
              id={`${name}-words`}
              name={`${name}-pick`}
              checked={form.pick === "words"}
              onChange={() => set({ pick: "words", another: false })}
            />
            <label htmlFor={`${name}-words`}>
              <span className="qs-opt-label">{C.ownWords}</span>
            </label>
          </div>
          {form.pick === "words" && (
            <div className="qs-sub">
              <label htmlFor={`${name}-text`} className="qs-label">
                {C.ownWordsLabel}
              </label>
              <textarea
                id={`${name}-text`}
                className="field"
                rows={3}
                value={form.text}
                {...(joinStep ? { "aria-describedby": `${name}-text-d` } : {})}
                onChange={(e) => set({ text: e.target.value })}
              />
              {joinStep && (
                <span id={`${name}-text-d`} className="qs-hint">
                  {C.ownWordsJoin}
                </span>
              )}
            </div>
          )}
        </div>
      </fieldset>
      <fieldset className="qs-section">
        <legend>{C.scope}</legend>
        <div className="qs-scope">
          <div className="qs-radio">
            <input
              type="radio"
              id={`${name}-repo`}
              name={`${name}-scope`}
              checked={form.scope === "repo"}
              onChange={() => set({ scope: "repo" })}
            />
            <label htmlFor={`${name}-repo`}>
              {isChangeQuestion(q) ? C.scopeChange(q.repo) : C.scopeRepo(q.repo)}
              {q.scope.level === "repo" ? ` (${C.proposed})` : ""}
            </label>
          </div>
          <div className="qs-radio">
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
        </div>
        {form.scope === "repo-type" && q.scope.level !== "repo-type" && (
          <div className="qs-field">
            <label htmlFor={`${name}-type-id`} className="qs-field-label">
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
        <div className="qs-field">
          <label htmlFor={`${name}-match`} className="qs-field-label">
            {C.rule.label}
          </label>
          <input
            id={`${name}-match`}
            className="field mono"
            value={form.match ?? ""}
            aria-describedby={`${name}-match-d`}
            onChange={(e) => set({ match: e.target.value })}
          />
          <span id={`${name}-match-d`} className="qs-hint">
            {offer ? `${C.rule.offer(offer.ids.length, offer.calls, offer.match)} ` : ""}
            {C.rule.hint}
          </span>
        </div>
      )}
      <div className="qs-actions">
        {error && (
          <p role="alert" className="state error" style={{ margin: 0 }}>
            {error}
          </p>
        )}
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? C.saving : C.submit}
        </button>
      </div>
    </form>
  );
  return (
    <div className="qs-detail">
      <h2 className="qs-q">{q.question}</h2>
      <p className="qs-meta">
        <span>
          {askedByWords(q.askedBy, day(q.askedBy.at))} · {q.repo} · {forRole ? `${forRole} · ` : ""}
          <code className="mono">{q.id}</code>
        </span>
        <CopyButton text={q.id} label={C.copyId} />
      </p>
      {/* ADR 0191: who answers it is by what it asks; a person sends it to another role. */}
      {q.state !== "retired" && (
        <RouteQuestion
          id={q.id}
          role={p.role ?? q.role}
          asks={p.asks ?? q.asks}
          routed={q.routed}
          {...(p.onRouted ? { onRouted: p.onRouted } : {})}
        />
      )}
      <section className="qs-section" aria-labelledby={`${name}-read`}>
        <h3 id={`${name}-read`} className="qs-label">
          {C.evidence}
        </h3>
        <Evidence id={q.id} refs={q.evidence} />
      </section>
      {q.answer && (
        <div className="qs-answered">
          <p style={{ margin: 0 }}>
            {/* ADR 0181: an AI answer is the AI's, never a person's: said so, with its chip. */}
            {ignored && !isAiBy(q.answer.by) ? (
              C.ignore.answered(q.answer.by, day(q.answer.at), ignored.reason)
            ) : (
              <>
                {isAiBy(q.answer.by)
                  ? COPY.decisions.answeredByAi(day(q.answer.at))
                  : C.answered(q.answer.by, day(q.answer.at))}
                : {q.answer.text ?? q.options[(q.answer.option ?? 1) - 1]?.label}
              </>
            )}
            {q.answer.match ? ` · ${C.rule.answered(q.answer.match)}` : ""}
          </p>
          {(isAiBy(q.answer.by) || correcting) && (
            <AiMark
              item={q.id}
              run={isAiBy(q.answer.by) ? q.answer.by.run : undefined}
              ai
              onOpen={() => setCorrecting(true)}
              onClose={() => setCorrecting(false)}
            />
          )}
          {q.answer.proposal && (
            <>
              <p className="muted" style={{ margin: 0 }}>
                {/* Ninth UX walk: an AI answer was applied by Atticus, never confirmed by a person. */}
                {isAiBy(q.answer.by)
                  ? C.fromAiProposal(
                      q.answer.proposal.by,
                      day(q.answer.proposal.at),
                      q.answer.by.run,
                    )
                  : C.fromProposal(q.answer.proposal.by, day(q.answer.proposal.at))}
              </p>
              <ul className="qs-cites">
                {q.answer.proposal.cites.map((c) => (
                  <li key={`${c.repo ?? q.repo}:${c.file}:${c.line}`}>
                    <span className="mono">
                      {c.repo ?? q.repo} {c.file}:{c.line}
                    </span>{" "}
                    <q>{c.quote}</q>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {q.state === "answered" && !done && applyRepoOf(q.rerun) && (
        <ApplyPending repo={applyRepoOf(q.rerun)!} file={`questions/${q.id}.yaml`} />
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
      ) : q.answer && isAiBy(q.answer.by) && !done ? (
        // Ninth UX walk: one way to change an AI answer: Correct (above), which spreads.
        <p className="ev-say" style={{ margin: 0 }}>
          {C.changeAiAnswer}
        </p>
      ) : folded ? (
        // Beta.26: an answer given stays short; changing it opens the form in place.
        <details className="qs-change">
          <summary>{C.change}</summary>
          {answerForm}
        </details>
      ) : (
        answerForm
      )}
      {done && <AnsweredView result={done} />}
    </div>
  );
}

/**
 * Beta.26: focus moves to the question opened (WCAG 2.4.3) without the page jumping: its side of
 * the page shows the question from its top, and the page's head and filters stay where they are.
 */
export function focusInPlace(
  el: {
    focus: (o?: FocusOptions) => void;
    closest?: (selector: string) => { scrollTop: number } | null;
    scrollIntoView?: (o?: ScrollIntoViewOptions) => void;
  } | null,
  // Review (beta.26): at 1000 px or narrower (questions.css) the list and the question stack and
  // the page scrolls as one, so the question opened below the list is brought into view.
  stacked: boolean = typeof matchMedia === "function" && matchMedia("(max-width: 1000px)").matches,
): void {
  if (!el) return;
  el.focus({ preventScroll: true });
  if (stacked) {
    el.scrollIntoView?.({ block: "start" });
    return;
  }
  const pane = el.closest?.(".qs-pane");
  if (pane) pane.scrollTop = 0;
}

function Detail({
  id,
  onAnswered,
  proposal,
  rule,
  role,
  asks,
}: {
  id: string;
  onAnswered: () => void;
  proposal?: Proposal;
  rule?: RuleOffer;
  role?: string;
  asks?: string;
}) {
  const q = useApi<QuestionView>(`/api/questions/${id}`);
  useReloadOnFiles(q);
  const heading = useRef<HTMLDivElement>(null);
  // Move focus to the question when it opens from the list, for keyboard and screen reader users.
  useEffect(() => {
    if (q.state === "ready") focusInPlace(heading.current);
  }, [q.state, id]);
  return (
    <div ref={heading} tabIndex={-1} className="qs-focus">
      <View of={q}>
        {(d) => (
          <QuestionDetail
            key={d.id}
            question={d}
            onAnswered={onAnswered}
            {...(proposal ? { proposal } : {})}
            {...(rule ? { rule } : {})}
            {...(role ? { role } : {})}
            {...(asks ? { asks } : {})}
            onRouted={() => {
              q.reload();
              onAnswered();
            }}
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

/** What a bulk answer did: the questions answered, and why each of the others wasn't. */
export interface BulkResult {
  ok: string[];
  failed: { id: string; why: string }[];
}

/** A bulk answer's result: how many were answered, why the others weren't, and what to run next. */
export function BulkResultView({ r, onDismiss }: { r: BulkResult; onDismiss: () => void }) {
  // The form it came from may be gone: the result takes the focus, never the page's body.
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [r]);
  return (
    <div role="status" className="qs-done" tabIndex={-1} ref={ref} style={{ marginBottom: 10 }}>
      <p className="state" style={{ margin: 0 }}>
        {C.bulk.done(r.ok.length)}
      </p>
      {r.failed.map((f) => (
        <p key={f.id} className="state error" style={{ margin: 0 }}>
          {f.id}: {f.why}
        </p>
      ))}
      {r.ok.length > 0 && <code className="mono">{C.bulk.next}</code>}
      <div className="qs-group-btns">
        <button type="button" className="btn" onClick={onDismiss}>
          {COPY.app.dismiss}
        </button>
      </div>
    </div>
  );
}

/**
 * Several open questions answered the same way (beta.14): where their calls go (a repo, system or
 * team, the first question's picks offered), or the same words. Each is answered on its own, as
 * one answer would be; what failed says why, and the rest stand.
 */
export function BulkAnswer(p: {
  ids: string[];
  questions: QuestionView[];
  /** What it did; the page shows it (BulkResultView), as the form goes with the answered ones. */
  onDone: (r: BulkResult) => void;
  onClear: () => void;
}) {
  const targetsOnly = p.questions.every((q) => q.askedBy.step === "facts-targets");
  const [how, setHow] = useState<"target" | "words">(targetsOnly ? "target" : "words");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
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
    p.onDone({ ok, failed });
  };
  return (
    <form className="qs-detail" onSubmit={(e) => void submit(e)} noValidate>
      <h2 className="qs-q">{C.bulk.title(p.ids.length)}</h2>
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
      <div className="qs-field">
        <label htmlFor="bulk-value" className="qs-field-label">
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
        <span id="bulk-hint" className="qs-hint">
          {C.bulk.hint}
        </span>
      </div>
      <div className="qs-actions">
        {error && (
          <p role="alert" className="state error" style={{ margin: 0 }}>
            {error}
          </p>
        )}
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

/**
 * Seventh UX walk: AI proposes first. Proposed answers came only from /atticus-propose, which the
 * page never named; here it is, with its command, while questions are open. Each proposal then
 * shows on its question, and a person accepts it or answers otherwise.
 *
 * Ninth UX walk (ADR 0181): it says what happens as runtime.yaml's decide says (with auto, each
 * proposal that meets the bar is applied as the AI's, Detected by AI; paused, why), and hands the
 * line to the person's assistant as an Atticus hand-off run whose Done reads the proposals in.
 */
export function AskAiToProposeView(p: {
  open: number;
  /** runtime.yaml's decide and the pause, from GET /api/decisions; unknown while it loads. */
  decide?: Api.DecisionsViewT["decide"] | undefined;
  /** The hand-off run open for the assistant (GET /api/propose-answers). */
  handoff?: Api.QuestionsProposeViewT | undefined;
  busy?: "handoff" | "done" | undefined;
  /** What Done said, or why it or the hand-off couldn't be done. */
  note?: { ok: boolean; lines: string[] } | undefined;
  onHandoff?: () => void;
  onDone?: () => void;
}) {
  const P = C.proposal;
  if (p.open === 0 && !p.note) return null;
  const slash = p.handoff?.line ?? "/atticus-propose";
  const command = "atticus questions propose";
  const d = p.decide;
  const why = d?.paused
    ? P.askWhyPaused(d.paused.why)
    : d?.now.questions === "auto" && d.decideIn?.includes("hand-off") !== false
      ? P.askWhyAuto
      : P.askWhy;
  const waiting = p.handoff?.state === "waiting" && p.handoff.run ? p.handoff : undefined;
  return (
    <section aria-labelledby="ask-ai-propose" className="qs-ai">
      <h2 id="ask-ai-propose" className="qs-label">
        {P.askTitle}
      </h2>
      <p className="qs-ai-why">{why}</p>
      {waiting ? (
        <>
          <p className="work-say" role="status" style={{ margin: 0 }}>
            {P.askWaiting(waiting.run!)}
          </p>
          <div className="work-cmd">
            <code className="mono">{slash}</code>
            <CopyButton text={slash} label={`${P.askCopy}: ${slash}`} />
          </div>
          {p.onDone && (
            <div className="qs-group-btns">
              <button
                type="button"
                className="btn primary"
                disabled={!!p.busy}
                aria-busy={p.busy === "done"}
                onClick={p.onDone}
              >
                {p.busy === "done" ? P.askReading : P.askDone}
              </button>
            </div>
          )}
          {waiting.done && (
            <>
              <p className="work-say" style={{ margin: 0 }}>
                {P.askTerminal}
              </p>
              <div className="work-cmd">
                <code className="mono">{waiting.done}</code>
                <CopyButton text={waiting.done} label={`${P.askCopy}: ${waiting.done}`} />
              </div>
            </>
          )}
        </>
      ) : (
        <>
          {p.onHandoff && p.open > 0 && (
            <div className="qs-group-btns">
              <button
                type="button"
                className="btn"
                disabled={!!p.busy}
                aria-busy={p.busy === "handoff"}
                onClick={p.onHandoff}
              >
                {p.busy === "handoff" ? P.askHandingOff : P.askHandoff}
              </button>
            </div>
          )}
          <p className="work-say" style={{ margin: 0 }}>
            {P.askSlash}
          </p>
          <div className="work-cmd">
            <code className="mono">{slash}</code>
            <CopyButton text={slash} label={`${P.askCopy}: ${slash}`} />
          </div>
          <p className="work-say" style={{ margin: 0 }}>
            {P.askCommand}
          </p>
          <div className="work-cmd">
            <code className="mono">{command}</code>
            <CopyButton text={command} label={`${P.askCopy}: ${command}`} />
          </div>
        </>
      )}
      {p.note && (
        <div role={p.note.ok ? "status" : "alert"} className={p.note.ok ? "ev-say" : "state error"}>
          {p.note.ok && <p style={{ margin: 0 }}>{P.askRead}</p>}
          <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 11.5 }}>
            {p.note.lines.join("\n")}
          </pre>
        </div>
      )}
    </section>
  );
}

const linesOf = (e: unknown): string[] => {
  const prob = (e as { problem?: { detail?: string; lines?: string[] } }).problem;
  if (prob?.lines?.length) return prob.lines;
  if (prob?.detail) return [prob.detail];
  return [e instanceof Error ? e.message : String(e)];
};

export function AskAiToPropose({ open }: { open: number }) {
  const ds = useDecisions();
  const v = readyView(ds);
  const h = useApi<Api.QuestionsProposeViewT>(open > 0 ? "/api/propose-answers" : undefined);
  const [busy, setBusy] = useState<"handoff" | "done" | undefined>();
  const [note, setNote] = useState<{ ok: boolean; lines: string[] } | undefined>();
  const handoff = h.state === "ready" ? h.data : undefined;
  return (
    <AskAiToProposeView
      open={open}
      decide={v?.decide}
      handoff={handoff}
      busy={busy}
      note={note}
      onHandoff={() => {
        setBusy("handoff");
        setNote(undefined);
        api<Api.QuestionsProposeViewT>("/api/propose-answers", { method: "POST" })
          .then(
            () => h.reload(),
            (e: unknown) => setNote({ ok: false, lines: linesOf(e) }),
          )
          .finally(() => setBusy(undefined));
      }}
      onDone={() => {
        const run = handoff?.run;
        if (!run) return;
        setBusy("done");
        setNote(undefined);
        callAsJob<{ lines?: string[] }>(`/api/runs/${encodeURIComponent(run)}/done`)
          .then(
            (r) => {
              setNote({ ok: true, lines: r.lines ?? [] });
              h.reload();
              ds?.reload();
            },
            (e: unknown) => setNote({ ok: false, lines: linesOf(e) }),
          )
          .finally(() => setBusy(undefined));
      }}
    />
  );
}

/** ADR 0181: how the questions were settled, three ways (from code, by a person, by AI). */
export function QuestionsAiCounts() {
  const v = readyView(useDecisions());
  return v ? (
    <SplitCounts counts={v.questions.counts} what={COPY.decisions.counts.questions} />
  ) : null;
}

/**
 * Beta.27: the questions to answer, both kinds, as Home's tile, the activity bar's badge and the
 * status bar count them; nothing until both kinds are known.
 */
export function QuestionsToAnswerLine({ of }: { of: QuestionsToAnswer | undefined }) {
  if (!of) return null;
  return <p className="qs-to-answer">{C.toAnswer(of.total, of.steps, of.owner)}</p>;
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
  // Seventh UX walk: only the tiles that pick the list's filter are buttons; the others are counts.
  const tile = (label: string, n: number, tone: string, pick?: "open" | "all") =>
    pick ? (
      <button
        type="button"
        className={`q-stat ${tone}`}
        aria-pressed={p.filter === pick}
        onClick={() => p.onFilter(pick)}
      >
        <span className="q-stat-n">{n}</span>
        <span className="q-stat-label">{label}</span>
      </button>
    ) : (
      <div className={`q-stat q-stat-count ${tone}`}>
        <span className="q-stat-n">{n}</span>
        <span className="q-stat-label">{label}</span>
      </div>
    );
  return (
    <div className="q-stats" role="group" aria-label={C.counts.label(p.repo)}>
      {/* Beta.27: these are the steps' questions only; the line above counts both kinds. */}
      <span className="q-stats-caption hud" aria-hidden="true">
        {C.counts.caption}
      </span>
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

/** Eighth UX walk: the change Questions is opened for (`?change=`), if any. */
export const changeOfHash = (hash: string) => queryParam(hash, "change") || undefined;

/**
 * The list a change's Questions shows: the questions its steps asked (askedForChange), counted
 * from those alone. Without a change, the list as read.
 */
export function scopeToChange<L extends Loaded<QuestionListView>>(
  list: L,
  change: string | undefined,
): L {
  if (!change || list.state !== "ready") return list;
  const { counts: _all, ...rest } = list.data;
  return {
    ...list,
    data: { ...rest, questions: list.data.questions.filter((q) => askedForChange(q, change)) },
  };
}

/** The page's opening words: a change's own, or the map's. */
export function QuestionsIntro({ change }: { change?: string | undefined }) {
  return change ? (
    <p className="qs-intro">
      {C.changeIntro(change)} {C.onlyChange(change)} <a href="#/questions">{C.showAll}</a>
    </p>
  ) : (
    <p className="qs-intro">{C.intro}</p>
  );
}

/**
 * The list and the question side by side, each pane scrolling on its own (beta.26 review): as
 * tall as the area that scrolls the page has left under them (the IDE layout's page, above its
 * bottom panel; the window in the classic layout), measured as the map's canvas is and given to
 * the CSS as --qs-pane-h, not the window's height less a guess.
 */
export function PaneSplit({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const h = useAvailableHeight(ref, { min: 240 });
  return (
    <div ref={ref} className="qs-split" style={{ "--qs-pane-h": `${h}px` } as CSSProperties}>
      {children}
    </div>
  );
}

export function Questions({ hash }: { hash: string }) {
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [whose, setWhose] = useState<"all" | "mine">("all");
  // ADR 0181 part 4: one change's questions and one role's, from the address (Home links here).
  const [scope, setScope] = useState(() => roleScopeOf(hash));
  // Review round 46: the address sets the scope when its change or role changes, not when only
  // the question opened does, so opening one keeps the role picked.
  const hashScope = JSON.stringify(roleScopeOf(hash));
  useEffect(() => setScope(JSON.parse(hashScope) as ReturnType<typeof roleScopeOf>), [hashScope]);
  const fetched = useApi<QuestionListView>(withRoleScope(questionsUrl(filter, whose), scope));
  // UX review (2026-11-08): the knowledge gaps' owner questions, the ones Home counts too.
  const owner = useApi<Api.OwnerQuestionListT>("/api/owner-questions");
  useReloadOnFiles(fetched, owner);
  // Eighth UX walk: opened for a change (?change=, "Answer them on Questions"), the page shows
  // the questions its steps asked, says so, and links to every question.
  const forChange = changeOfHash(hash);
  // ADR 0181 part 4: the server narrows to the change (?change=) by the same rule and more
  // (its stages' questions, those resting on it); the client narrowing stays for an older server.
  const list = scope.change ? fetched : scopeToChange(fetched, forChange);
  const [kind, setKind] = useState<QuestionsKind>(questionsKind(hash));
  useEffect(() => setKind(questionsKind(hash)), [hash]);
  // Beta.27: the questions to answer, both kinds, counted as Home, the badge and the status bar
  // count them (whatever this page's filters show): the counts under it are the steps' only.
  const toAnswer = questionsToAnswerOf(
    useKnownAnswer<StepQuestionsAnswer>(STEP_QUESTIONS_PATH),
    owner.state === "ready" ? owner.data : undefined,
  );

  const current = questionRoute(hash);
  const [text, setText] = useState("");
  const [repo, setRepo] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Review round 46: what the last bulk answer did, kept past the reload that takes the answered
  // ones off an open list (and the form with them), until the person closes it.
  const [bulkDone, setBulkDone] = useState<BulkResult | undefined>();
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
    <div className="qs">
      <div className="qs-head">
        <p className="qs-title">{C.title}</p>
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
      <QuestionsToAnswerLine of={toAnswer} />
      {kind === "owner" ? (
        <>
          <p className="qs-intro">{C.ownerQuestions.intro}</p>
          <section className="qs-counts" aria-label={C.ownerQuestions.title}>
            <OwnerQuestionList of={owner} onAnswered={owner.reload} />
          </section>
        </>
      ) : (
        <>
          <div className="qs-tools">
            <FilterBox id={FILTER_ID} value={text} onChange={setText} />
            {/* A change's questions are one change's, so no repo to pick among. */}
            {!forChange && (
              <div className="qs-field">
                <label htmlFor="questions-repo" className="qs-field-label">
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
            )}
            <RoleFilter
              value={scope.role}
              onChange={(r) => setScope((x) => scopeWithRole(x, r))}
              byRole={list.state === "ready" ? list.data.counts?.byRole : undefined}
              yours={list.state === "ready" ? list.data.yourRoles : undefined}
            />
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
          <QuestionsIntro change={forChange} />
          {list.state === "ready" && (
            <div className="qs-summary">
              <div className="qs-counts">
                <QuestionCounts
                  counts={countsOf(list.data, repo)}
                  {...(repo ? { repo } : {})}
                  filter={filter}
                  onFilter={setFilter}
                />
                <QuestionsAiCounts />
              </div>
              <AskAiToPropose open={countsOf(list.data).open} />
            </div>
          )}
          <PaneSplit>
            <section className="panel qs-pane" aria-labelledby="p-questions">
              <div className="row between">
                <h2 id="p-questions" className="h">
                  {C.listTitle}
                </h2>
              </div>
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
                change={forChange}
                role={scope.role}
              />
            </section>
            <section className="panel qs-pane">
              {bulkDone && <BulkResultView r={bulkDone} onDismiss={() => setBulkDone(undefined)} />}
              {picked.length > 0 ? (
                <BulkAnswer
                  key={picked.map((q) => q.id).join(",")}
                  ids={picked.map((q) => q.id)}
                  questions={picked}
                  onDone={(r) => {
                    setBulkDone(r);
                    // The answered ones are let go; what failed stays picked, to try again.
                    select(r.ok, false);
                    list.reload();
                  }}
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
                  {...(list.state === "ready" && list.data.about?.[current]?.role
                    ? { role: list.data.about[current].role }
                    : {})}
                  {...(list.state === "ready" && list.data.about?.[current]?.asks
                    ? { asks: list.data.about[current].asks }
                    : {})}
                />
              ) : (
                <div className="state">{C.pickFromList}</div>
              )}
            </section>
          </PaneSplit>
        </>
      )}
    </div>
  );
}
