import { useEffect, useRef, useState } from "react";
import { AdminFold, nonAdminRoles } from "./HomeRoles.js";
import {
  applyFirstRepos,
  BringIn,
  PendingProposals,
  waitingFiles,
  workChanged,
  type Plan,
} from "../app/propose.js";
import { COPY } from "../copy.js";
import {
  api,
  ApiError,
  catalogMayHaveChanged,
  FILE_QUIET_MS,
  isOffline,
  useApi,
  useFileChanges,
  useLiveEvents,
  type Loaded,
} from "../api/client.js";
import { confirmed } from "../api/confirm.js";
import { useMe } from "../app/me.js";
import type { Api } from "@maycombhq/core";
import { FilterBox, FilterCount, FilterEmpty, filteredWhat } from "../app/filter.js";
import {
  holdsPhase,
  inboxOf,
  levelsOfRoles,
  waitingByChange,
  type InboxData,
  type InboxItem,
  type WaitingSection,
} from "../app/inbox.js";
import { Panel } from "../app/ui.js";
import { useNeedsAcross } from "./knowledge/NeedsAcross.js";
import type { QuestionListView } from "./Questions.js";
import { waitingQuestions } from "./OwnerQuestions.js";
import { questionsToAnswerOf } from "../app/question-counts.js";
import { Propose } from "../app/propose.js";
import { stageOf, type OnboardingData } from "./work/next.js";
import { HomeEstate, HomeNext, SlashCommands } from "./work/Overview.js";
import { Command } from "./work/RunNext.js";
import { YourRoleQuestions } from "./RoleQuestions.js";
import { DecidePaused, readyView, useDecisions } from "../app/decisions.js";
import { UpgradeOffer } from "../app/upgrade.js";
import { TileGroup, toneOf, type Tile } from "./home/HomeTiles.js";
import { HomeChanges, HomePanel, NeedsTop, TOP } from "./home/HomePanels.js";

/** ADR 0181: when the sample audit paused AI deciding, Home says why, with Map › Trust's link. */
export function HomeDecidePaused() {
  const v = readyView(useDecisions());
  return v ? <DecidePaused decide={v.decide} /> : null;
}

const T = COPY.commandCenter;
const H = T.home;

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
  /** 3.6.0 (ADR 0191): what it asks, business, design or delivery. */
  asks?: string;
}
interface KindCount {
  kind: string;
  count: number;
  stale: number;
}

const PHASES = ["define", "design", "plan", "build", "qa", "release-ready"] as const;
/** The states a change is in flight in: its phases, sent back, and its review after release. */
const ACTIVE = new Set<string>([...PHASES, "returned", "post-release-review"]);

/**
 * Seventh UX walk: why a part didn't load, as the server answered; the server being down is said
 * once at the top of the page, so here it is short.
 */
const loadWhy = (why: string | undefined) => (!why || isOffline(why) ? COPY.app.offlineShort : why);

interface Setup {
  baselined: boolean;
  steps: {
    id: string;
    label: string;
    done: boolean;
    detail: string;
    fix?: string;
    optional?: boolean;
    /** beta.23: the machine's checks still run; Home doesn't wait for them. */
    checking?: boolean;
  }[];
}
/** beta.26: Home loads /api/setup once, for the checklist and the person's own install both. */
type SetupLoad = Loaded<Setup> & { reload: () => void };

/**
 * beta.23: while the machine's checks run, wait for them here (GET /api/doctor answers when they
 * finish), then read the checklist again. The rest of Home doesn't wait.
 */
function WhenMachineChecked({ onDone }: { onDone: () => void }) {
  const d = useApi<{ ok: boolean }>("/api/doctor");
  const done = d.state !== "loading";
  useEffect(() => {
    if (done) onDone();
  }, [done, onDone]);
  return null;
}

/**
 * What runs a step here (ADR 0121 item 6), in one line from GET /api/settings/ai, with a link to
 * the AI tab. Nothing while it loads; a sentence when it can't be read.
 */
export function HowStepsRunLine({
  runs,
  failed,
  why,
}: {
  runs?: string;
  failed?: boolean;
  /** Seventh UX walk: what the server answered; runtime.yaml is named only when it names it. */
  why?: string;
}) {
  if (failed)
    return (
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        {T.howStepsRunCantRead(loadWhy(why))}
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
      {...(ai.state === "error" ? { why: ai.error } : {})}
    />
  );
}

/** One handle, as atticus orgpack owner takes it. */
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

/**
 * Who looks after the org pack, set on a person's click (PUT /api/orgpack/owner): pack.yaml's
 * owner, the same line atticus orgpack owner writes, then proposed for review like any file.
 */
export function OrgPackOwnerForm({ onSaved }: { onSaved?: () => void }) {
  const [owner, setOwner] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | undefined>();
  const h = owner.trim();
  const bad = h !== "" && !HANDLE.test(h);
  return (
    <form
      className="stack"
      style={{ gap: 4, marginTop: 4 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!h || bad) return;
        setBusy(true);
        api("/api/orgpack/owner", { method: "PUT", body: { owner: h, was: "" } })
          .then(() => {
            setNote({ ok: true, text: T.ownerSaved(h) });
            onSaved?.();
          })
          .catch((err: unknown) =>
            setNote({
              ok: false,
              text:
                err instanceof ApiError ? (err.problem.detail ?? err.problem.title) : String(err),
            }),
          )
          .finally(() => setBusy(false));
      }}
    >
      <label className="stack" htmlFor="org-pack-owner" style={{ gap: 2 }}>
        <span style={{ fontSize: 12.5 }}>{T.ownerLabel}</span>
        <span className="muted" id="org-pack-owner-hint" style={{ fontSize: 12 }}>
          {T.ownerHint}
        </span>
      </label>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <input
          id="org-pack-owner"
          className="field mono"
          value={owner}
          autoComplete="off"
          aria-describedby="org-pack-owner-hint"
          aria-invalid={bad || undefined}
          onChange={(e) => setOwner(e.target.value)}
        />
        <button type="submit" className="btn primary" disabled={busy || !h || bad}>
          {busy ? T.ownerSaving : T.ownerSave}
        </button>
      </div>
      {bad && (
        <p role="alert" style={{ margin: 0, fontSize: 12 }}>
          {T.ownerBad}
        </p>
      )}
      {note && (
        <p role={note.ok ? "status" : "alert"} style={{ margin: 0, fontSize: 12.5 }}>
          {note.text}
        </p>
      )}
    </form>
  );
}

/** ADR 0188: what a setup step says to do, in the app's words where the app does it. */
const SETUP_FIX: Record<string, string> = {
  clones: COPY.appStep.setupClones,
  scan: COPY.appStep.setupRead,
  baseline: COPY.appStep.setupBaseline,
  // Beta.23 review: the machine's checks are on Settings › This machine, with Check again.
  machine: COPY.appStep.setupMachine,
};

/** A setup step's fix in the app's words; the server's own while the machine is checked. */
const setupFix = (x: Setup["steps"][number]) => (x.checking ? x.fix : (SETUP_FIX[x.id] ?? x.fix));

/** The machine's step is failing (its checks ran): the person's own install needs fixing. */
const machineFailing = (x: Setup["steps"][number]) => x.id === "machine" && !x.done && !x.checking;

/** The link to the page that has the machine's checks, each with its fix, and Check again. */
function OpenMachine() {
  return (
    <span>
      <a className="btn" href="#/settings">
        {COPY.appStep.openMachine}
      </a>
    </span>
  );
}

/**
 * Beta.23 review: what a folded Home (a product owner's, a business analyst's) still shows
 * outside the fold, since it is about the person's own install: a failing machine step, and the
 * alert that a newer Atticus upgraded this metarepo. The rest of setting up stays folded.
 */
export function OwnInstall(p: { setup?: SetupLoad } = {}) {
  const own = useApi<Setup>(p.setup ? undefined : "/api/setup");
  const setup = p.setup ?? own;
  useFileChanges(() => setup.reload(), FILE_QUIET_MS, { jobs: true });
  const machine =
    setup.state === "ready" && !setup.data.baselined
      ? setup.data.steps.find(machineFailing)
      : undefined;
  return (
    <>
      {machine && (
        <section
          className="state error stack"
          role="alert"
          aria-label={COPY.appStep.ownInstall}
          style={{ gap: 6 }}
        >
          <span style={{ fontSize: 13 }}>
            {machine.label}
            <span className="muted" style={{ fontSize: 12 }}>
              {" "}
              · {machine.detail}
            </span>
          </span>
          <span className="muted" style={{ fontSize: 12 }}>
            {setupFix(machine)}
          </span>
          <OpenMachine />
        </section>
      )}
      <UpgradeOffer part="newer" />
    </>
  );
}

/** Guided setup: the checklist until the catalog is accepted (ADR 0047). */
export function SetupChecklist(p: { setup?: SetupLoad } = {}) {
  const own = useApi<Setup>(p.setup ? undefined : "/api/setup");
  const setup = p.setup ?? own;
  // Beta.23 review: read again when files change or a step's job ends (a Sync clones into
  // workspace/, which no event names), so a step done in the app is ticked here.
  useFileChanges(() => setup.reload(), FILE_QUIET_MS, { jobs: true });
  const [note, setNote] = useState<{ ok: boolean; text: string } | undefined>();
  // UX review (2026-11-08): the checklist hides once baselined, but the note and Propose for
  // review of catalog/baseline.yaml stay after this page's accept (ADR 0183).
  const [accepted, setAccepted] = useState(false);
  if (accepted)
    return (
      <div className="bento">
        <Panel title={T.baselineAccepted} kind="hero" span="1 / -1">
          <p role="status" style={{ margin: "0 0 8px", fontSize: 12.5 }}>
            {T.theCatalogIsAccepted}
          </p>
          <Propose scope="baseline" />
        </Panel>
      </div>
    );
  if (setup.state !== "ready" || setup.data.baselined) return null;
  const s = setup.data;
  const done = s.steps.filter((x) => x.done).length;
  const scanned = s.steps.find((x) => x.id === "scan")?.done;
  const accept = async () => {
    try {
      await api("/api/baseline", { method: "POST", body: {} });
      setAccepted(true);
      setup.reload();
      // Eighth UX walk: the baseline is one more file to propose; Home's count reads it again.
      workChanged();
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
                className={`chip ${x.done ? "done" : x.optional || x.checking ? "dim" : "warn"}`}
                style={{ minWidth: 24, textAlign: "center" }}
              >
                {x.done ? "✓" : x.checking ? "…" : "·"}
              </span>
              <span className="stack" style={{ gap: 2 }} aria-busy={x.checking || undefined}>
                <span style={{ fontSize: 13 }}>
                  {x.label}
                  <span className="sr">{x.done ? T.done : x.checking ? T.checking : T.toDo}</span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {" "}
                    · {x.detail}
                    {x.optional ? T.optional : ""}
                  </span>
                </span>
                {!x.done && x.fix && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    {setupFix(x)}
                  </span>
                )}
                {machineFailing(x) && <OpenMachine />}
                {/* ADR 0188: the daily steps of setup are buttons here, the commands folded. */}
                {!x.done && x.id === "clones" && (
                  <Command text="atticus workspace sync" label={COPY.runNext.copy} />
                )}
                {!x.done && x.id === "scan" && (
                  <span>
                    <a className="btn primary" href="#/trust">
                      {COPY.appStep.openTrust}
                    </a>
                  </span>
                )}
                {/* Seventh UX walk: the owner is set here, not by editing pack.yaml. */}
                {!x.done && x.id === "org-pack-owner" && (
                  <OrgPackOwnerForm onSaved={() => setup.reload()} />
                )}
              </span>
            </li>
          ))}
        </ol>
        {s.steps.some((x) => x.checking) && <WhenMachineChecked onDone={setup.reload} />}
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

/**
 * Beta.26 review: an estate not set up yet, said in one line at the top of Home (the checklist
 * is a fold at the foot, so Home doesn't scroll), with a button that opens the fold.
 */
export function SetupLine(p: { setup: SetupLoad; onShow: () => void }) {
  if (p.setup.state !== "ready" || p.setup.data.baselined) return null;
  const s = p.setup.data;
  return (
    <p className="hm-quiet-line hm-setup-line">
      {H.setupLine(s.steps.filter((x) => x.done).length, s.steps.length)}{" "}
      <button type="button" className="btn" onClick={p.onShow}>
        {H.setupShow}
      </button>
    </p>
  );
}

/** Opens a fold and puts the keyboard on its summary, so the person is where it opened. */
export function openFold(
  d: Pick<HTMLDetailsElement, "open" | "querySelector"> | null | undefined,
): void {
  if (!d) return;
  d.open = true;
  d.querySelector<HTMLElement>("summary")?.focus();
}

/**
 * The status line at the top of Home (beta.26 review): it counts what the Blocking findings tile
 * counts, so the two never disagree.
 */
export function homeStatus(
  listState: "loading" | "error" | "ready",
  blocking: number,
): { text: string; bad: boolean } {
  if (listState === "error") return { text: COPY.app.ccCantRead, bad: false };
  if (listState === "loading") return { text: COPY.app.ccReading, bad: false };
  return blocking > 0
    ? { text: T.thingsNeedAttention(blocking), bad: true }
    : { text: T.nothingIsBlockedRight, bad: false };
}

/** The top few of a count by name, the most first: "96 Interface · 30 Table · 12 System". */
export function topCounts(counts: Iterable<[string, number]>, n = 3): string {
  return [...counts]
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([what, c]) => H.count(c, what))
    .join(" · ");
}

interface DigestResult {
  title: string;
  lines: string[];
  sent?: { id: string; channel: string };
  notSent?: string;
}

/** See what waits on you as one message, or send it to yourself through the notify adapter. */
export function DigestButtons({ to }: { to?: string }) {
  const [busy, setBusy] = useState(false);
  const [d, setD] = useState<DigestResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const go = async (send: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      // ADR 0186: sending posts a message as the person, so the click is their confirmation.
      // Review round 50: of the channel the button shows (an older server knows only "me").
      const yes = send ? await confirmed("digest-send", to ?? "me") : {};
      setD(await api<DigestResult>("/api/me/digest", { method: "POST", body: { send, ...yes } }));
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
          {to ? T.sendItTo(to) : T.sendItToMe}
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

/** A count still loading, or why it didn't load. */
type CountStatus = { state: "loading" } | { state: "error"; error: string } | undefined;

/**
 * What waits on you, by kind (ADR 0105), as Home's first tiles (beta.26): what waits on you
 * (the open needs across every change and the manual steps, said apart under it), the questions
 * to answer, and the blocking findings (with the open findings by source under it), each linking
 * to where it is acted on. A count not loaded shows a dash, never a 0 that reads as "none".
 */
export function waitingTiles(p: {
  /** Beta.27: the questions to answer, both kinds (question-counts.ts), said apart under it. */
  questions: number | undefined;
  questionsOf?: { steps: number; owner: number } | undefined;
  /** Where Questions to answer opens: the owner questions when only they wait. */
  questionsHref?: string | undefined;
  needs: number | undefined;
  steps: number | undefined;
  blocking: number | undefined;
  status?: Partial<Record<"questions" | "needs" | "steps" | "blocking", CountStatus>>;
  /** What the open findings are (Findings by lens folded into the tile). */
  blockingSub?: string | undefined;
}): { wait: Tile; questions: Tile; blocking: Tile } {
  const of = (s: CountStatus): Pick<Tile, "state" | "error"> =>
    s?.state === "error" ? { state: "error", error: s.error } : { state: s?.state ?? "ready" };
  const both = p.needs !== undefined && p.steps !== undefined ? p.needs + p.steps : undefined;
  const ns = p.status?.needs;
  const ss = p.status?.steps;
  return {
    wait: {
      id: "wait",
      label: H.waitOnYou,
      // The needs when any are open (Change › Needs across changes), else Home › Manual steps.
      href: p.needs ? "#/changes?across=needs" : "#/todo",
      value: both,
      ...of(ns?.state === "error" ? ns : ss?.state === "error" ? ss : (ns ?? ss)),
      ...(both !== undefined ? { sub: H.waitOnYouSub(p.needs!, p.steps!) } : {}),
      tone: toneOf(both, "waits"),
    },
    questions: {
      id: "questions",
      label: T.waitQuestions,
      href: p.questionsHref ?? "#/questions",
      value: p.questions,
      ...of(p.status?.questions),
      ...(p.questionsOf ? { sub: H.questionsSub(p.questionsOf.steps, p.questionsOf.owner) } : {}),
      tone: toneOf(p.questions, "waits"),
    },
    blocking: {
      id: "blocking",
      label: T.waitBlocking,
      href: "#/changes?across=findings",
      value: p.blocking,
      ...of(p.status?.blocking),
      tone: toneOf(p.blocking, "blocks"),
      ...(p.blockingSub ? { sub: p.blockingSub } : {}),
    },
  };
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
  // The selection changed kind (only steps left, say): an action with nothing to do is swapped.
  useEffect(() => {
    // Nothing selected is left (another window resolved them): nothing to swap to.
    if (!needs && !steps) return;
    if (!needs && action.startsWith("need-")) setAction("step-skip");
    else if (!steps && action.startsWith("step-")) setAction("need-done");
  }, [needs, steps, action]);
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
  /** Parts of the list that didn't load (a change's needs, the steps, the questions): said, not hidden. */
  partial?: string[];
  /** Seventh UX walk: what the server answered when the list didn't load. */
  error?: string;
  /** WP7.10: act on several needs or manual steps at once; without it, no checkboxes. */
  onBulk?: (items: InboxItem[], action: BulkAction, note: string) => Promise<void>;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const partial = p.partial?.length ? (
    <div className="state error" role="alert" style={{ marginBottom: 6 }}>
      {T.partlyLoaded(p.partial)}
    </div>
  ) : null;
  if (p.state === "loading")
    return (
      <div className="state" role="status">
        {T.loading}
      </div>
    );
  if (p.state === "error")
    return (
      <div className="state" role="alert">
        {T.couldntLoadWhatNeeds(loadWhy(p.error))}
      </div>
    );
  const w = waitingByChange(p.items, p.changes, p.text);
  if (w.total === 0)
    return (
      <>
        {partial}
        <div className="state">{T.nothingNeedsAPerson}</div>
      </>
    );
  return (
    <div className="stack" style={{ gap: 8 }}>
      {partial}
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        {T.byChangeIntro}
      </p>
      <FilterBox id={FILTER_ID} value={p.text} onChange={p.onText} />
      {p.onBulk && p.items.some((x) => picked.has(bulkKey(x))) && (
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

/**
 * Home: one screen (beta.26, the product owner: "make it concise, like a dashboard or control
 * screen"; the whole of it in the view at 1440 by 900, and in the IDE shell's Home tab). A line
 * of status; six tiles, each a number with one place to go (what waits on you, the questions to
 * answer, the changes in flight by stage, corrections to apply on the map, blocking findings with
 * the open findings by source, the facts in the catalog with interfaces and repos trusted); then
 * three short panels with their top few and See all: Next for you (Run next, what to propose,
 * your role's questions, Bring in what merged), what needs a person (the whole list one click
 * away, with its filter and bulk actions, and the digest in its menu), and your changes with the
 * current one's gate pipeline and the map's link. The slash commands and setting up are folds at
 * the foot. /api/setup and /api/propose are asked for once each, and no graph or diagram.
 */
export function CommandCenter() {
  const changes = useApi<ChangeSummary[]>("/api/changes");
  const findings = useApi<Finding[]>("/api/findings?state=open");
  const kinds = useApi<KindCount[]>("/api/catalog/kinds");
  // UX review (2026-11-08): the owner questions the Questions page answers, by the same call.
  const qs = useApi<Api.OwnerQuestionListT>("/api/owner-questions");
  const triage = useApi<{ data: { items?: InboxData["triage"] } | null }>("/api/view/triage");
  const todo = useApi<{ steps: InboxData["steps"] }>("/api/todo");
  const asked = useApi<QuestionListView>("/api/questions?state=open");
  const onboarding = useApi<OnboardingData>("/api/onboarding");
  const trust = useApi<Api.TrustViewT>("/api/trust");
  const knowledge = useApi<Api.KnowledgeItemListT>("/api/knowledge/items");
  // beta.26: one load each for a tile and the panel it sums up.
  const setup = useApi<Setup>("/api/setup");
  const plan = useApi<Plan>("/api/propose?scope=work");
  const [text, setText] = useState("");
  const [whole, setWhole] = useState(false);
  // Beta.26 review: the whole list, opened by its button, takes the keyboard to its heading.
  const focusWhole = useRef(false);
  const setupFold = useRef<HTMLDetailsElement | null>(null);
  // Set-up, once seen not done, stays a fold for this visit (its accepted note, Propose).
  const [setupShown, setSetupShown] = useState(false);
  if (!setupShown && setup.state === "ready" && !setup.data.baselined) setSetupShown(true);
  const [bulkNote, setBulkNote] = useState<string | undefined>();
  const { me } = useMe();
  // ADR 0191: the person's roles on each change in flight (its owners, else their pick).
  const [rolesBy, setRolesBy] = useState<Readonly<Record<string, string[]>>>({});
  const viewerRoles = [...new Set(Object.values(rolesBy).flat())];
  const levels = levelsOfRoles(viewerRoles);
  const fold = nonAdminRoles(viewerRoles);
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
    ...(levels ? { levels } : {}),
    questions: qs.state === "ready" ? qs.data.questions.filter((q) => q.state !== "answered") : [],
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
  // beta.23: a burst of file events is read once, and the catalog's counts only when the burst
  // can change the catalog. Beta.23 review: a step's job that ended is heard too (a Sync clones
  // into workspace/, which isn't watched), and Home reads what it shows again as for files.
  useFileChanges(
    (events) => {
      const files = events.some((e) => e.type === "file.changed" || e.type === "job.done");
      if (catalogMayHaveChanged(events)) kinds.reload();
      if (files || events.some((e) => e.type === "index.rebuilt")) {
        changes.reload();
        findings.reload();
      }
      if (files) {
        onboarding.reload();
        trust.reload();
        needs.reload();
        todo.reload();
        qs.reload();
        asked.reload();
        knowledge.reload();
      }
      if (!files && events.some((e) => e.type === "run.changed")) findings.reload();
    },
    FILE_QUIET_MS,
    { jobs: true },
  );

  const inFlight = changes.state === "ready" ? changes.data.filter((c) => ACTIVE.has(c.state)) : [];
  const open = findings.state === "ready" ? findings.data : [];
  // ADR 0191: a design finding doesn't hold a change in Define, and isn't the product owner's.
  const stateOf = new Map(
    (changes.state === "ready" ? changes.data : []).map((c) => [c.id, c.state]),
  );
  const atLevel = open.filter((f) => !levels || !f.asks || levels.includes(f.asks));
  const blocking = atLevel.filter(
    (f) => f.severity === "blocking" && holdsPhase(f.asks, stateOf.get(f.change)),
  );
  const notMine = open.filter((f) => levels && f.asks && !levels.includes(f.asks)).length;
  // Beta.27: the questions to answer, counted as the badge, the status bar and Questions count.
  const toAnswer = questionsToAnswerOf(
    asked.state === "ready" ? asked.data : undefined,
    qs.state === "ready" ? qs.data : undefined,
  );
  const waitingQs = waitingQuestions(toAnswer?.steps, toAnswer?.owner);
  const facts = kinds.state === "ready" ? kinds.data.reduce((a, k) => a + k.count, 0) : 0;
  const countOf = (kind: string) =>
    kinds.state === "ready" ? (kinds.data.find((k) => k.kind === kind)?.count ?? 0) : 0;
  // Findings by lens and by where they come from, folded into the Blocking findings tile.
  const byLens = new Map<string, number>();
  for (const f of open) byLens.set(f.lens ?? "checks", (byLens.get(f.lens ?? "checks") ?? 0) + 1);
  const topLens = [...byLens.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const ai = open.filter((f) => f.layer === "ai").length;
  const role = viewerRoles.map((r) => COPY.roles.who[r] ?? r).join(", ");
  const waiting = inbox.filter((x) => x.kind !== "phase").length;
  const listState: "loading" | "error" | "ready" =
    changes.state === "loading" || findings.state === "loading"
      ? "loading"
      : changes.state === "error" || findings.state === "error"
        ? "error"
        : "ready";
  const listError =
    changes.state === "error" ? changes.error : findings.state === "error" ? findings.error : "";
  const partial = [
    ...(needs.state === "ready"
      ? needs.data.filter((r) => r.error).map((r) => T.needsOfFailed(r.change, r.error!))
      : needs.state === "error"
        ? [T.needsFailed(needs.error)]
        : []),
    ...(todo.state === "error" ? [T.stepsFailed(todo.error)] : []),
    ...(qs.state === "error" ? [T.questionsFailed(qs.error)] : []),
    ...(triage.state === "error" ? [T.triageFailed(triage.error)] : []),
  ];
  const problems =
    (onboarding.state === "ready" ? onboarding.data.problems.length : 0) +
    (trust.state === "ready" ? trust.data.problems.length : 0);
  const status = homeStatus(listState, blocking.length);
  const wait = waitingTiles({
    questions: waitingQs.n,
    questionsOf: toAnswer,
    questionsHref: waitingQs.href,
    needs: needs.state === "ready" ? allNeeds.filter((n) => n.status === "open").length : undefined,
    steps: todo.state === "ready" ? todo.data.steps.length : undefined,
    blocking: findings.state === "ready" ? blocking.length : undefined,
    status: {
      questions: tileStatus(asked, qs),
      needs: tileStatus(needs),
      steps: tileStatus(todo),
      blocking: tileStatus(findings),
    },
    blockingSub: open.length ? H.findingsSub(open.length - ai, ai, topLens) : undefined,
  });

  return (
    <div className="hm">
      <header className="hm-head">
        <p className={`hm-status${status.bad ? " bad" : ""}`}>{status.text}</p>
        <p className="hm-who">
          {H.live}
          {me ? ` · ${H.you(me.user, role || undefined)}` : ""}
        </p>
      </header>
      {/* ADR 0191: for a product owner or business analyst, set-up is folded away (at the foot);
          what the person's own install needs is never folded away (beta.23 review). */}
      {fold ? (
        <OwnInstall setup={setup} />
      ) : (
        <>
          {/* Beta.26 review: one line here; the checklist is a fold at the foot. */}
          <SetupLine setup={setup} onShow={() => openFold(setupFold.current)} />
          {/* Ninth UX walk: the upgrade the metarepo waits on, run here on the person's click. */}
          <UpgradeOffer />
        </>
      )}
      <HomeDecidePaused />
      {problems > 0 && (
        <p className="state error" role="alert" style={{ margin: 0, textAlign: "left" }}>
          {H.problems} <a href="#/trust">{COPY.work.openTrust}</a>
        </p>
      )}

      <TileGroup
        id="hm-glance"
        title={H.glance}
        quiet
        tiles={[
          wait.wait,
          wait.questions,
          {
            id: "in-flight",
            label: H.inFlight,
            href: "#/changes",
            ...loadOf(changes),
            value: inFlight.length,
            sub: inFlight.length ? byStage(inFlight) : H.inFlightNone,
            tone: inFlight.length ? "plain" : "quiet",
          },
          correctionsTile(plan),
          wait.blocking,
          {
            id: "catalog",
            label: H.catalog,
            href: "#/trust",
            ...loadOf(kinds),
            value: facts,
            sub: H.catalogSub(
              countOf("Interface"),
              trust.state === "ready" && trust.data.repos.length
                ? H.trusted(
                    trust.data.repos.filter((r) => r.state === "trusted").length,
                    trust.data.repos.length,
                  )
                : undefined,
            ),
            tone: facts ? "plain" : "quiet",
          },
        ]}
      />

      <div className="hm-grid">
        <div className="hm-col">
          <HomePanel id="hm-next" title={H.next}>
            <HomeNext onboarding={onboarding} changes={changes} questions={asked} trust={trust} />
            <div className="hm-rest">
              <PendingProposals plan={plan} max={TOP} />
              {/* ADR 0181 part 4: each role answers its own questions on a change. Beta.26
                  review: its top few, the rest one link to Questions. */}
              {changes.state === "ready" && (
                <YourRoleQuestions compact max={TOP} changes={changes.data} onRoles={setRolesBy} />
              )}
              {/* Round 36 (Windows review): where a person comes back after their PR merged. */}
              <BringIn />
              {!fold && <HowStepsRun />}
            </div>
          </HomePanel>
        </div>
        <div className="hm-col">
          <HomePanel
            id="hm-needs"
            title={T.needsAPerson}
            meta={waiting ? H.needsMeta(waiting) : undefined}
          >
            {notMine > 0 && levels && !levels.includes("design") && (
              <p className="hm-quiet-line">{COPY.roleWork.home.designWaits(notMine)}</p>
            )}
            <NeedsTop
              items={inbox}
              changes={changes.state === "ready" ? changes.data : []}
              state={listState}
              error={listError}
              partial={partial}
            />
            <div className="hm-foot">
              <a href={waitingQs.href ?? "#/questions"}>{H.seeAllQuestions}</a>
              {listState === "ready" && waiting > 0 && (
                <button
                  type="button"
                  className="btn"
                  aria-expanded={whole}
                  {...(whole ? { "aria-controls": "hm-whole" } : {})}
                  onClick={() => {
                    focusWhole.current = !whole;
                    setWhole((w) => !w);
                  }}
                >
                  {whole ? H.hideWholeList : H.wholeList(waiting)}
                </button>
              )}
              {me && (
                <details className="hm-menu">
                  <summary>{H.digest}</summary>
                  <DigestButtons {...(me.notify?.to ? { to: me.notify.to } : {})} />
                </details>
              )}
            </div>
            {bulkNote && (
              <p role="status" className="hm-quiet-line">
                {bulkNote}
              </p>
            )}
          </HomePanel>
        </div>
        <div className="hm-col">
          {/* ADR 0191: the changes the person is on, and whom each waits on; the current one's
              gate pipeline first. */}
          <HomePanel
            id="hm-changes"
            title={viewerRoles.length ? H.changes : H.inFlight}
            meta={role || undefined}
          >
            <HomeChanges
              changes={changes}
              inFlight={inFlight}
              yours={
                viewerRoles.length
                  ? Object.entries(rolesBy)
                      .filter(([, r]) => r.length)
                      .map(([c]) => c)
                  : undefined
              }
              me={me?.user}
            />
          </HomePanel>
        </div>
      </div>

      {whole && (
        <HomePanel
          sectionId="hm-whole"
          id="hm-whole-t"
          title={H.wholeListTitle}
          headRef={(el) => {
            if (!el || !focusWhole.current) return;
            focusWhole.current = false;
            el.focus();
          }}
        >
          <WaitingList
            onBulk={async (items, action, note) => {
              const failed: string[] = [];
              const calls = bulkCalls(items, action, note);
              for (const c of calls)
                await api(c.path, { method: "POST", body: c.body }).catch((e: unknown) => {
                  failed.push(e instanceof Error ? e.message : String(e));
                });
              setBulkNote(T.bulkDone(calls.length - failed.length, failed.length, failed));
              needs.reload();
              todo.reload();
            }}
            items={inbox}
            changes={changes.state === "ready" ? changes.data : []}
            text={text}
            onText={setText}
            partial={partial}
            {...(listError ? { error: listError } : {})}
            state={listState}
          />
        </HomePanel>
      )}

      <div className="hm-folds">
        <div className="hm-fold-row">
          {fold && (
            <AdminFold fold>
              <HowStepsRun />
              <SetupChecklist setup={setup} />
              <UpgradeOffer part="pending" />
            </AdminFold>
          )}
          {!fold && setupShown && (
            <details className="hm-fold" ref={setupFold}>
              <summary>{T.setUpAtticus}</summary>
              <SetupChecklist setup={setup} />
            </details>
          )}
          {/* Beta.26 review: what is read and trusted, for every role: the top kinds in the
              catalog, the open findings by lens, coverage and trust. One line until opened. */}
          <details className="hm-fold">
            <summary>{COPY.work.estate}</summary>
            <div className="stack" style={{ gap: 8 }}>
              {kinds.state === "ready" && kinds.data.length > 0 && (
                <p className="hm-quiet-line">
                  {H.topKinds(topCounts(kinds.data.map((k) => [k.kind, k.count])))}{" "}
                  <a href="#/explore">{H.seeCatalog}</a>
                </p>
              )}
              {open.length > 0 && (
                <p className="hm-quiet-line">
                  {H.byLens(topCounts(byLens))}{" "}
                  <a href="#/changes?across=findings">{H.seeFindings}</a>
                </p>
              )}
              <HomeEstate
                onboarding={onboarding}
                trust={trust}
                changes={changes}
                withInFlight={false}
              />
            </div>
          </details>
          {/* beta.26: the slash commands' reference, one click away instead of a screen long. */}
          <details className="hm-fold">
            <summary>{H.assistant}</summary>
            <SlashCommands />
          </details>
        </div>
        <p className="hm-note">
          {T.approvingIsThePull} {T.aPersonApprovesEvery}
        </p>
      </div>
    </div>
  );
}

/** A tile's state from its loads: loading while any is, the first error, else ready. */
function tileStatus(
  ...of: Loaded<unknown>[]
): { state: "loading" } | { state: "error"; error: string } | undefined {
  const err = of.find((l) => l.state === "error");
  if (err?.state === "error") return { state: "error", error: err.error };
  return of.some((l) => l.state === "loading") ? { state: "loading" } : undefined;
}

/** A tile's state and error from one load. */
function loadOf(l: Loaded<unknown>): Pick<Tile, "state" | "error"> {
  return l.state === "error" ? { state: "error", error: l.error } : { state: l.state };
}

/** The changes in flight by stage, in the stages' order: "2 feature · 1 tasks". */
export function byStage(changes: readonly { state: string }[]): string {
  const order = ["feature", "architecture", "stories", "tasks", "release", "done"] as const;
  const n = new Map<string, number>();
  for (const c of changes) n.set(stageOf(c.state), (n.get(stageOf(c.state)) ?? 0) + 1);
  return order
    .filter((s) => n.has(s))
    .map((s) => H.inStage(n.get(s)!, COPY.work.stage[s]))
    .join(" · ");
}

/** Corrections saved and not applied yet, by repo (the map's bar has Apply), and files to propose. */
export function correctionsTile(plan: Loaded<Plan>): Tile {
  const repos = plan.state === "ready" ? applyFirstRepos(plan.data).length : 0;
  const files = plan.state === "ready" ? waitingFiles(plan.data) : 0;
  return {
    id: "corrections",
    label: H.corrections,
    href: "#/canvas",
    ...loadOf(plan),
    value: repos,
    sub: H.toPropose(files),
    tone: repos ? "warn" : "quiet",
  };
}
