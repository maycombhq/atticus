import { useState } from "react";
import { COPY } from "../copy.js";
import { api, ApiError, useApi, useLiveEvents } from "../api/client.js";
import { FlowCanvas, type FlowViewData } from "../app/flow.js";
import type { Graph } from "../app/graph.js";
import { useMe } from "../app/me.js";
import type { Api } from "@maycombhq/core";
import { FilterBox, FilterCount, FilterEmpty, filteredWhat } from "../app/filter.js";
import {
  inboxOf,
  waitingByChange,
  type InboxData,
  type InboxItem,
  type WaitingSection,
} from "../app/inbox.js";
import { Bar, Donut, Panel, Ring, View } from "../app/ui.js";
import { useNeedsAcross } from "./knowledge/NeedsAcross.js";

const T = COPY.commandCenter;

interface ChangeSummary {
  id: string;
  title: string;
  type: string;
  state: string;
  repos: string[];
  openFindings: { blocking: number; gap: number; risk: number; idea: number };
  updatedAt: string;
}
interface Finding {
  id: string;
  change: string;
  gate: string;
  lens?: string;
  layer: string;
  severity: "blocking" | "gap" | "risk" | "idea";
  kind: string;
  artifact: string;
  summary: string;
  state: string;
  question?: { text: string; owner?: string };
}
interface KindCount {
  kind: string;
  count: number;
  stale: number;
}

const PHASES = ["define", "design", "plan", "build", "qa", "release-ready"] as const;
const PHASE_LABEL: Record<string, string> = {
  define: T.define,
  design: T.design,
  plan: T.plan,
  build: T.build,
  qa: "QA",
  "release-ready": T.release,
};
const ACTIVE = new Set<string>([...PHASES, "returned", "post-release-review"]);

function stateChip(c: ChangeSummary) {
  if (c.openFindings.blocking > 0) return { cls: "blocking", text: T.blocked };
  return {
    cls: c.state === "release-ready" ? "warn" : "",
    text: (PHASE_LABEL[c.state] ?? c.state).toUpperCase(),
  };
}

interface Setup {
  baselined: boolean;
  steps: {
    id: string;
    label: string;
    done: boolean;
    detail: string;
    fix?: string;
    optional?: boolean;
  }[];
}

/**
 * What runs a step here (ADR 0121 item 6), in one line from GET /api/settings/ai, with a link to
 * the AI tab. Nothing while it loads; a sentence when it can't be read.
 */
export function HowStepsRunLine({ runs, failed }: { runs?: string; failed?: boolean }) {
  if (failed)
    return (
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        {T.howStepsRunCantRead}
      </p>
    );
  if (!runs) return null;
  return (
    <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
      {T.howStepsRun} <strong>{runs}</strong> · <a href="#/ai">{T.howStepsRunChange}</a>
    </p>
  );
}

function HowStepsRun() {
  const ai = useApi<{ runs?: string }>("/api/settings/ai");
  useLiveEvents((e) => {
    if (e.type === "file.changed") ai.reload();
  });
  return (
    <HowStepsRunLine
      {...(ai.state === "ready" && ai.data.runs ? { runs: ai.data.runs } : {})}
      failed={ai.state === "error"}
    />
  );
}

/** Guided setup: the checklist until the catalog is accepted (ADR 0047). */
function SetupChecklist() {
  const setup = useApi<Setup>("/api/setup");
  const [note, setNote] = useState<{ ok: boolean; text: string } | undefined>();
  if (setup.state !== "ready" || setup.data.baselined) return null;
  const s = setup.data;
  const done = s.steps.filter((x) => x.done).length;
  const scanned = s.steps.find((x) => x.id === "scan")?.done;
  const accept = async () => {
    try {
      await api("/api/baseline", { method: "POST", body: {} });
      setNote({
        ok: true,
        text: T.theCatalogIsAccepted,
      });
      setup.reload();
    } catch (e) {
      setNote({
        ok: false,
        text: e instanceof ApiError ? (e.problem.detail ?? e.problem.title) : String(e),
      });
    }
  };
  return (
    <div className="bento">
      <Panel title={T.setUpAtticus} kind="hero" span="1 / -1" meta={T.ofDone(done, s.steps.length)}>
        <ol style={{ listStyle: "none", margin: 0, padding: 0 }} className="stack">
          {s.steps.map((x) => (
            <li key={x.id} className="row" style={{ alignItems: "flex-start", gap: 10 }}>
              <span
                aria-hidden="true"
                className={`chip ${x.done ? "done" : x.optional ? "dim" : "warn"}`}
                style={{ minWidth: 24, textAlign: "center" }}
              >
                {x.done ? "✓" : "·"}
              </span>
              <span className="stack" style={{ gap: 2 }}>
                <span style={{ fontSize: 13 }}>
                  {x.label}
                  <span className="sr">{x.done ? T.done : T.toDo}</span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {" "}
                    · {x.detail}
                    {x.optional ? T.optional : ""}
                  </span>
                </span>
                {!x.done && x.fix && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    {x.fix}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
        {scanned && (
          <div className="row" style={{ marginTop: 12, gap: 10, flexWrap: "wrap" }}>
            <button type="button" className="btn primary" onClick={() => void accept()}>
              {T.acceptTheCatalogAs}
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              {T.afterWalkingTheEcosystem}
            </span>
          </div>
        )}
        {note && (
          <p role={note.ok ? "status" : "alert"} style={{ margin: "8px 0 0", fontSize: 12.5 }}>
            {note.text}
          </p>
        )}
      </Panel>
    </div>
  );
}

interface DigestResult {
  title: string;
  lines: string[];
  sent?: { id: string; channel: string };
  notSent?: string;
}

/** See what waits on you as one message, or send it to yourself through the notify adapter. */
function DigestButtons() {
  const [busy, setBusy] = useState(false);
  const [d, setD] = useState<DigestResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const go = async (send: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      setD(await api<DigestResult>("/api/me/digest", { method: "POST", body: { send } }));
    } catch (e) {
      setError(e instanceof ApiError ? (e.problem.detail ?? e.problem.title) : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack" style={{ gap: 6, marginTop: 10 }}>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <button type="button" className="btn" disabled={busy} onClick={() => void go(false)}>
          {T.showMyDigest}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void go(true)}>
          {T.sendItToMe}
        </button>
      </div>
      {error && (
        <p role="alert" style={{ margin: 0, color: "var(--magenta-text)", fontSize: 12.5 }}>
          {error}
        </p>
      )}
      {d && (
        <div role="status" className="stack" style={{ gap: 2, fontSize: 12.5 }}>
          <strong>{d.title}</strong>
          {d.lines.map((l, i) => (
            <span key={i} className="clamp2">
              {l}
            </span>
          ))}
          {d.sent && <span style={{ color: "var(--green)" }}>{T.sentTo(d.sent.channel)}</span>}
          {d.notSent && <span className="muted">{d.notSent}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * What waits on you, by kind (ADR 0105): questions, needs still open across every change,
 * manual steps and blocking findings, each with its count and a link to where it is acted on.
 * A count not loaded shows a dash, never a 0 that reads as "none".
 */
export function WaitingSections(p: {
  questions: number | undefined;
  needs: number | undefined;
  steps: number | undefined;
  blocking: number | undefined;
}) {
  const rows = [
    { label: T.waitQuestions, n: p.questions, href: "#/questions" },
    { label: T.waitNeeds, n: p.needs, href: "#/changes?across=needs" },
    { label: T.waitSteps, n: p.steps, href: "#/todo" },
    { label: T.waitBlocking, n: p.blocking, href: "#/changes?across=findings" },
  ];
  return (
    <ul
      className="row"
      style={{ listStyle: "none", margin: 0, padding: 0, gap: 8, flexWrap: "wrap" }}
    >
      {rows.map((r) => (
        <li key={r.href}>
          <a href={r.href} className="btn">
            {r.label}{" "}
            <span className={`chip ${r.n ? "warn" : "dim"}`}>
              {r.n === undefined ? (
                <>
                  <span aria-hidden="true">–</span>
                  <span className="sr">{COPY.app.notLoaded}</span>
                </>
              ) : (
                r.n
              )}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

const SECTION: Record<WaitingSection["kind"], (s: WaitingSection) => string> = {
  need: () => T.sectionNeeds,
  finding: () => T.sectionFindings,
  step: () => T.sectionSteps,
  question: (s) => T.sectionQuestions(s.repo),
  triage: () => T.sectionTriage,
  knowledge: () => T.sectionKnowledge,
};
const groupId = (change?: string) =>
  `waiting-${(change ?? "no-change").replace(/[^a-z0-9-]/gi, "-")}`;
const FILTER_ID = "waiting-filter";

/** WP7.10: what a person can do to several waiting items at once, with one reason for all. */
export type BulkAction = "need-done" | "need-not-needed" | "step-skip";

/** Needs and manual steps can be acted on together; the rest are looked at one by one. */
export const bulkable = (x: InboxItem) =>
  (x.kind === "need" && !!x.change && !!x.id) || (x.kind === "step" && !!x.id);

export const bulkKey = (x: InboxItem) => `${x.kind}|${x.change ?? ""}|${x.id ?? ""}`;

/** The calls one bulk action makes: one per item it applies to, each with the same reason. */
export function bulkCalls(
  items: InboxItem[],
  action: BulkAction,
  note: string,
): { path: string; body: Record<string, unknown> }[] {
  const reason = note.trim();
  if (!reason) return [];
  return items.flatMap((x): { path: string; body: Record<string, unknown> }[] => {
    if (action === "step-skip" && x.kind === "step" && x.id)
      return [
        {
          path: `/api/todo/${encodeURIComponent(x.id)}/done`,
          body: { skip: true, note: reason, ...(x.change ? { change: x.change } : {}) },
        },
      ];
    if (action !== "step-skip" && x.kind === "need" && x.change && x.id)
      return [
        {
          path: `/api/changes/${encodeURIComponent(x.change)}/needs/${encodeURIComponent(x.id)}`,
          body: { status: action === "need-done" ? "done" : "not-needed", note: reason },
        },
      ];
    return [];
  });
}

function WaitingRow({
  x,
  selected,
  onSelect,
}: {
  x: InboxItem;
  selected?: boolean;
  onSelect?: (on: boolean) => void;
}) {
  return (
    <li className="row" style={{ gap: 6, alignItems: "flex-start" }}>
      {onSelect && bulkable(x) && (
        <input
          type="checkbox"
          aria-label={T.select(x.title)}
          checked={!!selected}
          onChange={(e) => onSelect(e.target.checked)}
          style={{ marginTop: 10 }}
        />
      )}
      <a
        href={x.href}
        className="list-row"
        style={{ alignItems: "flex-start", textDecoration: "none", color: "inherit" }}
      >
        <span style={{ minWidth: 0 }}>
          <span className="clamp2" style={{ fontSize: 12.5 }}>
            {x.title}
          </span>
          <span className="hud" style={{ fontSize: 9.5 }}>
            {x.detail}
          </span>
        </span>
        <span className={`chip ${x.blocking ? "blocking" : x.kind === "finding" ? "warn" : ""}`}>
          {x.kind.toUpperCase()}
        </span>
      </a>
    </li>
  );
}

/** The bar over the list when items are selected: one action and one reason for all of them. */
export function BulkBar(p: {
  selected: InboxItem[];
  onDo: (action: BulkAction, note: string) => void;
  onClear: () => void;
  busy?: boolean;
}) {
  const needs = p.selected.filter((x) => x.kind === "need").length;
  const steps = p.selected.filter((x) => x.kind === "step").length;
  const [action, setAction] = useState<BulkAction>(needs ? "need-done" : "step-skip");
  const [note, setNote] = useState("");
  const applies = bulkCalls(p.selected, action, note || "-").length;
  return (
    <form
      className="row"
      style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}
      aria-label={T.bulkTitle}
      onSubmit={(e) => {
        e.preventDefault();
        if (note.trim()) p.onDo(action, note);
      }}
    >
      <span>{T.selected(p.selected.length)}</span>
      <label className="stack" style={{ gap: 2 }}>
        <span className="hud">{T.bulkAction}</span>
        <select
          id="bulk-action"
          className="field"
          value={action}
          onChange={(e) => setAction(e.target.value as BulkAction)}
        >
          {needs > 0 && <option value="need-done">{T.bulkNeedDone(needs)}</option>}
          {needs > 0 && <option value="need-not-needed">{T.bulkNeedNot(needs)}</option>}
          {steps > 0 && <option value="step-skip">{T.bulkStepSkip(steps)}</option>}
        </select>
      </label>
      <label className="stack" style={{ gap: 2 }}>
        <span className="hud">{action === "need-done" ? T.bulkTicket : T.bulkWhy}</span>
        <input
          id="bulk-note"
          className="field"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          required
        />
      </label>
      <button type="submit" className="btn primary" disabled={p.busy || !note.trim()}>
        {T.bulkDo(applies)}
      </button>
      <button type="button" className="btn" onClick={p.onClear}>
        {T.bulkClear}
      </button>
    </form>
  );
}

/**
 * What needs a person, grouped by change (ADR 0105 addendum), with the filter every list that
 * grows has. Pure, so tests render it in each state.
 */
export function WaitingList(p: {
  items: InboxItem[];
  changes: { id: string; title: string; state?: string }[];
  text: string;
  onText: (v: string) => void;
  state: "loading" | "error" | "ready";
  /** WP7.10: act on several needs or manual steps at once; without it, no checkboxes. */
  onBulk?: (items: InboxItem[], action: BulkAction, note: string) => Promise<void>;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  if (p.state === "loading")
    return (
      <div className="state" role="status">
        {T.loading}
      </div>
    );
  if (p.state === "error")
    return (
      <div className="state" role="alert">
        {T.couldntLoadWhatNeeds}
      </div>
    );
  const w = waitingByChange(p.items, p.changes, p.text);
  if (w.total === 0) return <div className="state">{T.nothingNeedsAPerson}</div>;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        {T.byChangeIntro}
      </p>
      <FilterBox id={FILTER_ID} value={p.text} onChange={p.onText} />
      {p.onBulk && picked.size > 0 && (
        <BulkBar
          selected={p.items.filter((x) => picked.has(bulkKey(x)))}
          busy={busy}
          onClear={() => setPicked(new Set())}
          onDo={(action, note) => {
            setBusy(true);
            void p.onBulk!(
              p.items.filter((x) => picked.has(bulkKey(x))),
              action,
              note,
            ).finally(() => {
              setBusy(false);
              setPicked(new Set());
            });
          }}
        />
      )}
      <FilterCount shown={w.shown} total={w.total} active={!!p.text.trim()} />
      {w.groups.length === 0 && (
        <FilterEmpty
          what={filteredWhat({ text: p.text })}
          onClear={() => p.onText("")}
          focus={FILTER_ID}
        />
      )}
      {w.groups.map((g) => (
        <section key={g.change ?? ""} aria-labelledby={groupId(g.change)}>
          <h3
            id={groupId(g.change)}
            className="h row"
            style={{ fontSize: 14, margin: "6px 0", gap: 6, flexWrap: "wrap" }}
          >
            {g.change ? (
              <>
                <a href={`#/changes/${encodeURIComponent(g.change)}`}>{g.title}</a>
                <span className="muted mono" style={{ fontSize: 11 }}>
                  {g.change}
                </span>
              </>
            ) : (
              <span>{g.title}</span>
            )}
            <span className="chip">{T.groupCount(g.count)}</span>
            {g.blocking > 0 && <span className="chip blocking">{T.blocked}</span>}
            {g.state && (
              <span className="hud" style={{ fontSize: 10 }}>
                {T.inState(g.state)}
              </span>
            )}
          </h3>
          {g.sections.map((s) => (
            <div key={`${s.kind}|${s.repo ?? ""}`}>
              <h4 className="hud" style={{ fontSize: 11, margin: "6px 0" }}>
                {SECTION[s.kind](s)}
              </h4>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {s.items.map((x, k) => (
                  <WaitingRow
                    key={`${x.id ?? ""}|${k}`}
                    x={x}
                    selected={picked.has(bulkKey(x))}
                    {...(p.onBulk
                      ? {
                          onSelect: (on: boolean) =>
                            setPicked((prev) => {
                              const next = new Set(prev);
                              if (on) next.add(bulkKey(x));
                              else next.delete(bulkKey(x));
                              return next;
                            }),
                        }
                      : {})}
                  />
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

export function CommandCenter() {
  const changes = useApi<ChangeSummary[]>("/api/changes");
  const findings = useApi<Finding[]>("/api/findings?state=open");
  const kinds = useApi<KindCount[]>("/api/catalog/kinds");
  const qs = useApi<{ data: { questions?: InboxData["questions"] } | null }>("/api/view/questions");
  const triage = useApi<{ data: { items?: InboxData["triage"] } | null }>("/api/view/triage");
  const todo = useApi<{ steps: InboxData["steps"] }>("/api/todo");
  const asked = useApi<{ questions: NonNullable<InboxData["questionFiles"]> }>(
    "/api/questions?state=open",
  );
  const knowledge = useApi<Api.KnowledgeItemListT>("/api/knowledge/items");
  const [text, setText] = useState("");
  const [bulkNote, setBulkNote] = useState<string | undefined>();
  const { me } = useMe();
  const needs = useNeedsAcross(changes);
  const allNeeds =
    needs.state === "ready"
      ? needs.data.flatMap((r) => (r.needs?.needs ?? []).map((n) => ({ ...n, change: r.change })))
      : [];
  // The same list for everyone: there are no roles (ADR 0073).
  const inbox = inboxOf({
    needs: allNeeds,
    changes: changes.state === "ready" ? changes.data : [],
    findings: findings.state === "ready" ? findings.data : [],
    questions: qs.state === "ready" ? (qs.data.data?.questions ?? []) : [],
    triage: triage.state === "ready" ? (triage.data.data?.items ?? []) : [],
    steps: todo.state === "ready" ? todo.data.steps : [],
    questionFiles: asked.state === "ready" ? asked.data.questions : [],
    // Knowledge no one has verified, or whose page changed since it was: when the page knows it.
    ...(knowledge.state === "ready"
      ? {
          knowledgeToVerify: knowledge.data.items.filter(
            (i) => !i.review || i.review.state === "stale",
          ).length,
        }
      : {}),
  });
  const graph = useApi<Graph>("/api/graph");
  // The map is the estate's context view; with one system, that system's components and links.
  const systems =
    graph.state === "ready"
      ? [
          ...new Set(
            graph.data.nodes.map((n) => n.system ?? (n.kind === "System" ? n.id : undefined)),
          ),
        ]
          .filter((x): x is string => !!x)
          .sort()
      : [];
  const map = useApi<{ view: FlowViewData }>(
    graph.state !== "ready" || graph.data.nodes.length === 0
      ? undefined
      : systems.length === 1
        ? `/api/diagram/container/graph?focus=${encodeURIComponent(systems[0]!)}`
        : "/api/diagram/context/graph",
  );
  useLiveEvents((e) => {
    if (e.type === "index.rebuilt" || e.type === "file.changed") {
      kinds.reload();
      graph.reload();
      map.reload();
      changes.reload();
      findings.reload();
    }
    if (e.type === "file.changed") {
      needs.reload();
      todo.reload();
      qs.reload();
      asked.reload();
      knowledge.reload();
    }
    if (e.type === "run.changed") findings.reload();
  });

  const inFlight = changes.state === "ready" ? changes.data.filter((c) => ACTIVE.has(c.state)) : [];
  const open = findings.state === "ready" ? findings.data : [];
  const blocking = open.filter((f) => f.severity === "blocking");
  const gaps = open.filter((f) => f.severity === "gap");
  const questions = qs.state === "ready" ? (qs.data.data?.questions?.length ?? 0) : 0;
  const facts = kinds.state === "ready" ? kinds.data.reduce((a, k) => a + k.count, 0) : 0;
  const interfaces =
    kinds.state === "ready" ? (kinds.data.find((k) => k.kind === "Interface")?.count ?? 0) : 0;
  const focus = inFlight[0];
  const byLens = new Map<string, number>();
  for (const f of open) byLens.set(f.lens ?? "checks", (byLens.get(f.lens ?? "checks") ?? 0) + 1);
  const lensMax = Math.max(1, ...byLens.values());

  return (
    <>
      <div className="row between" style={{ flexWrap: "wrap" }}>
        <p className="n" style={{ margin: 0, fontSize: 24, letterSpacing: "0.02em" }}>
          {changes.state === "error" || findings.state === "error"
            ? COPY.app.ccCantRead
            : changes.state !== "ready" || findings.state !== "ready"
              ? COPY.app.ccReading
              : blocking.length + gaps.length > 0
                ? T.thingsNeedAttention(blocking.length + gaps.length)
                : T.nothingIsBlockedRight}
        </p>
        <span className="hud">
          {me ? T.liveFromYourMetarepo(me.user) : T.liveFromYourMetarepo2}
        </span>
      </div>
      <HowStepsRun />
      <SetupChecklist />
      <div className="bento">
        <Panel title={T.waitingOnYou} span="1 / -1">
          <p className="muted" style={{ margin: "0 0 8px", fontSize: 12.5 }}>
            {T.waitingIntro}
          </p>
          <WaitingSections
            questions={qs.state === "ready" ? questions : undefined}
            needs={
              needs.state === "ready"
                ? allNeeds.filter((n) => n.status === "open").length
                : undefined
            }
            steps={todo.state === "ready" ? todo.data.steps.length : undefined}
            blocking={findings.state === "ready" ? blocking.length : undefined}
          />
        </Panel>
        <Panel
          title={T.needsAPerson}
          span="1 / -1"
          meta={inbox.filter((x) => x.kind !== "phase").length || undefined}
        >
          <WaitingList
            onBulk={async (items, action, note) => {
              let failed = 0;
              const calls = bulkCalls(items, action, note);
              for (const c of calls)
                await api(c.path, { method: "POST", body: c.body }).catch(() => {
                  failed++;
                });
              setBulkNote(T.bulkDone(calls.length - failed, failed));
              needs.reload();
              todo.reload();
            }}
            items={inbox}
            changes={changes.state === "ready" ? changes.data : []}
            text={text}
            onText={setText}
            state={
              changes.state === "loading" || findings.state === "loading"
                ? "loading"
                : changes.state === "error" || findings.state === "error"
                  ? "error"
                  : "ready"
            }
          />
          {bulkNote && (
            <p role="status" className="muted" style={{ margin: "6px 0 0" }}>
              {bulkNote}
            </p>
          )}
          {me && <DigestButtons />}
        </Panel>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        {T.approvingIsThePull}
      </p>

      <div className="bento" role="list" aria-label={T.keyNumbers}>
        {[
          // A count not loaded shows a dash, never a 0 that reads as "none".
          {
            label: T.changesInFlight2,
            value: changes.state === "ready" ? inFlight.length : undefined,
            color: "var(--text)",
          },
          {
            label: T.blockingFindings,
            value: findings.state === "ready" ? blocking.length : undefined,
            color: blocking.length ? "var(--magenta)" : "var(--text)",
          },
          {
            label: T.openOwnerQuestions,
            value: qs.state === "ready" ? questions : undefined,
            color: questions ? "var(--amber)" : "var(--text)",
          },
          {
            label: T.factsInTheCatalog,
            value: kinds.state === "ready" ? facts : undefined,
            color: "var(--accent)",
          },
        ].map((k) => (
          <div key={k.label} role="listitem" className="panel" style={{ gridColumn: "span 3" }}>
            <div className="hud" style={{ fontSize: 10 }}>
              {k.label}
            </div>
            <div className="n" style={{ fontSize: 30, color: k.color }}>
              {k.value === undefined ? (
                <>
                  <span aria-hidden="true">–</span>
                  <span className="sr">{COPY.app.notLoaded}</span>
                </>
              ) : (
                k.value.toLocaleString()
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="bento">
        <Panel title={focus ? T.gatePipeline(focus.id) : T.gatePipeline2} span="span 5">
          <View of={changes} empty={() => !focus} emptyText={T.noChangeInFlight}>
            {() => {
              const at = PHASES.indexOf(focus!.state as (typeof PHASES)[number]);
              return (
                <div className="row between" style={{ gap: 6 }}>
                  {PHASES.map((p, i) => (
                    <div key={p} className="stack" style={{ alignItems: "center", gap: 6 }}>
                      {i === at ? (
                        <Ring
                          value={i + 1}
                          max={PHASES.length}
                          size={48}
                          label={T.currentPhase(PHASE_LABEL[p] ?? "")}
                        />
                      ) : (
                        <span
                          aria-label={`${PHASE_LABEL[p]}: ${i < at ? T.done2 : T.toCome}`}
                          role="img"
                          style={{
                            width: 44,
                            height: 44,
                            borderRadius: "50%",
                            border: `1.5px solid ${i < at ? "var(--btn-text)" : "var(--step-off)"}`,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: i < at ? "var(--btn-text)" : "var(--muted)",
                          }}
                        >
                          {i < at ? "✓" : ""}
                        </span>
                      )}
                      <span
                        className="hud"
                        style={{ fontSize: 10, color: i === at ? "var(--accent)" : undefined }}
                      >
                        {PHASE_LABEL[p]}
                      </span>
                    </div>
                  ))}
                </div>
              );
            }}
          </View>
        </Panel>

        <Panel title={T.changesInFlight} meta={`${inFlight.length}`} span="span 4">
          <View of={changes} empty={() => inFlight.length === 0} emptyText={T.noChangesInFlight}>
            {() =>
              inFlight.map((c) => {
                const s = stateChip(c);
                return (
                  <div key={c.id} className="list-row">
                    <a
                      href={`#/changes/${c.id}`}
                      className="mono"
                      style={{ fontSize: 12, textDecoration: "none" }}
                    >
                      {c.id}
                    </a>
                    <span className={`chip ${s.cls}`}>{s.text}</span>
                  </div>
                );
              })
            }
          </View>
        </Panel>

        <Panel title={T.interfaces} kind="dark" span="span 3">
          <View of={kinds}>
            {() => (
              <div className="stack">
                <span className="big">{interfaces}</span>
                <span className="hud" style={{ fontSize: 10 }}>
                  {T.interfacesInTheCatalog}
                </span>
              </div>
            )}
          </View>
        </Panel>

        <Panel
          title={T.systemMap}
          kind="hero"
          span="span 8"
          rows="span 2"
          meta={<a href="#/explore">{T.explore}</a>}
        >
          <View of={graph} empty={(g) => g.nodes.length === 0} emptyText={T.theCatalogIsEmpty}>
            {() => (
              <View
                of={map}
                empty={(m) => m.view.nodes.length === 0}
                emptyText={T.theCatalogIsEmpty}
              >
                {(m) => <FlowCanvas view={m.view} height={420} />}
              </View>
            )}
          </View>
        </Panel>

        <Panel title={T.findingsByLens} span="span 4">
          <View of={findings} empty={(f) => f.length === 0} emptyText={T.noOpenFindings}>
            {() => (
              <div className="stack">
                {[...byLens.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([lens, n]) => (
                    <div key={lens} className="row" style={{ gap: 8 }}>
                      <span className="hud" style={{ width: 96, fontSize: 10 }}>
                        {lens}
                      </span>
                      <div style={{ flex: 1 }}>
                        <Bar value={n} max={lensMax} label={T.findings(lens)} />
                      </div>
                      <span className="n" style={{ fontSize: 14 }}>
                        {n}
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </View>
        </Panel>

        <Panel title={T.whereFindingsComeFrom} kind="dark" span="span 4">
          <View of={findings} empty={(f) => f.length === 0} emptyText={T.noOpenFindings}>
            {(f) => (
              <Donut
                title={T.openFindingsBySource}
                parts={[
                  {
                    label: T.checksFromCode,
                    value: f.filter((x) => x.layer !== "ai").length,
                    color: "var(--accent)",
                  },
                  {
                    label: T.aiLenses,
                    value: f.filter((x) => x.layer === "ai").length,
                    color: "var(--magenta)",
                  },
                ]}
              />
            )}
          </View>
        </Panel>

        <Panel title={T.catalog} span="span 4">
          <View of={kinds} empty={(k) => k.length === 0} emptyText={T.noFactsYet}>
            {(k) => {
              const top = [...k].sort((a, b) => b.count - a.count).slice(0, 5);
              const max = Math.max(1, ...top.map((x) => x.count));
              return (
                <div className="stack">
                  {top.map((x) => (
                    <div key={x.kind} className="row" style={{ gap: 8 }}>
                      <span className="hud" style={{ width: 110, fontSize: 10 }}>
                        {x.kind}
                      </span>
                      <div style={{ flex: 1 }}>
                        <Bar value={x.count} max={max} label={T.records(x.kind)} />
                      </div>
                      <span className="n" style={{ fontSize: 14 }}>
                        {x.count}
                      </span>
                    </div>
                  ))}
                </div>
              );
            }}
          </View>
        </Panel>
      </div>
      <p className="hud" style={{ textAlign: "center", fontSize: 10, color: "var(--faint)" }}>
        {T.aPersonApprovesEvery}
      </p>
    </>
  );
}
