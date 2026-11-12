import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type JSX,
  type KeyboardEvent,
} from "react";
import {
  catalogMayHaveChanged,
  isOffline,
  useFileChanges,
  useServerBack,
} from "../../api/client.js";
import { COPY } from "../../copy.js";
import { useKnownAnswer, useLazyApi, type Lazy } from "./explorer-data.js";
import {
  MANIFEST_REPOS_PATH,
  manifestMayHaveChanged,
  repoCountsOf,
  type ManifestReposAnswer,
  type RepoCounts,
} from "../repo-counts.js";
import {
  OWNER_QUESTIONS_PATH,
  questionsToAnswerOf,
  STEP_QUESTIONS_PATH,
  type StepQuestionsAnswer,
} from "../question-counts.js";
import {
  changeItems,
  domId,
  filterItems,
  focusAfterUnpin,
  PIN_BUTTON_ID,
  pageLabel,
  pinnedItems,
  estateLabels,
  questionItems,
  SECTION_IDS,
  systemItems,
  treeKey,
  visibleRows,
  type ChangeRow,
  type EstateNode,
  type ExItem,
  type Row,
  type SectionId,
  type SectionModel,
} from "./explorer-model.js";
import { pinHash, togglePin, usePins } from "./pinned-pages.js";
import "./explorer.css";

/**
 * The Explorer (the IDE shell's side panel, beta.26; the mock-up's "Estate" panel): the changes
 * in flight with their stage, the systems as a tree of their repos, the open questions by repo,
 * and the pinned pages. Each section folds; each is a tree (WAI-ARIA's tree view: one tab stop,
 * arrow keys, Home and End, Enter opens, a letter jumps); a filter at the top narrows them all.
 * Every item opens its page through `onOpen(hash)`, which the shell makes a tab.
 */

const E = COPY.explorer;

/** The map's own estate view, three levels down: systems, their repos, the repos' components. */
export const ESTATE_PATH = "/api/graph/node/estate?lens=architecture&depth=3";
export const CHANGES_PATH = "/api/changes";
export const QUESTIONS_PATH = STEP_QUESTIONS_PATH;
export const OWNER_PATH = OWNER_QUESTIONS_PATH;

/** Which sections the viewer left open, per viewer, as the menu keeps More pages. */
export const OPEN_KEY = "atticus.explorer.sections";
type Open = Record<SectionId, boolean>;
const ALL_OPEN: Open = { changes: true, systems: true, questions: true, pinned: true };

function readOpen(): Open {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(OPEN_KEY) ?? "{}") as unknown;
    if (!v || typeof v !== "object") return ALL_OPEN;
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      SECTION_IDS.map((id) => [id, typeof o[id] === "boolean" ? o[id] : true]),
    ) as Open;
  } catch {
    return ALL_OPEN;
  }
}

function saveOpen(o: Open): void {
  try {
    globalThis.localStorage?.setItem(OPEN_KEY, JSON.stringify(o));
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
}

export interface ExplorerViewProps {
  current: string;
  filter: string;
  sections: SectionModel[];
  /** The tree items opened (a system's repos shown). */
  expanded: ReadonlySet<string>;
  /** Each tree's focused row: its one tab stop. */
  focus: Partial<Record<SectionId, string>>;
  /** Whether the page open now is pinned. */
  pinnedHere: boolean;
  onFilter: (text: string) => void;
  onToggleSection: (id: SectionId) => void;
  onToggleItem: (itemId: string) => void;
  onOpen: (hash: string) => void;
  onRetry: (id: SectionId) => void;
  onPinHere: () => void;
  onTreeKey: (id: SectionId, e: KeyboardEvent<HTMLUListElement>) => void;
  onTreeFocus: (id: SectionId, itemId: string) => void;
}

/** Whether a row is the page open now: the same address, Home's empty one as Home's. */
const isCurrent = (item: ExItem, current: string) => pinHash(item.hash) === pinHash(current);

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={open ? "ex-chev open" : "ex-chev"}
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

/** One row's words for a screen reader: its name, full name, stage, kind, count and mark. */
function spoken(item: ExItem): string {
  return E.spoken(
    item.label,
    ...(item.title ? [item.title] : []),
    ...(item.detail ? [item.detail] : []),
    ...(item.kind ? [E.kindWords[item.kind]] : []),
    ...(item.count !== undefined
      ? [
          item.countOf === "repos"
            ? E.repos(item.count)
            : item.countOf === "components"
              ? E.components(item.count)
              : E.items(item.count),
        ]
      : []),
    ...(item.waits ? [E.waitsOnYou] : []),
  );
}

function TreeItem(p: {
  row: Row;
  rows: readonly Row[];
  tabStop: string | undefined;
  expanded: ReadonlySet<string>;
  current: string;
  level: number;
  onOpen: (hash: string) => void;
  onToggleItem: (itemId: string) => void;
}): JSX.Element {
  const { item } = p.row;
  const kids = item.children ?? [];
  const parent = kids.length > 0;
  const open = parent && p.expanded.has(item.id);
  const here = isCurrent(item, p.current);
  return (
    <li
      id={domId(item.id)}
      role="treeitem"
      aria-level={p.row.level}
      aria-setsize={p.row.setSize}
      aria-posinset={p.row.posInSet}
      aria-expanded={parent ? open : undefined}
      aria-label={spoken(item)}
      aria-current={here ? "page" : undefined}
      {...(item.pin ? { "aria-keyshortcuts": "Delete", "aria-description": E.unpinHint } : {})}
      tabIndex={p.tabStop === item.id ? 0 : -1}
      data-id={item.id}
      className="ex-item"
    >
      <div
        className={here ? "ex-row here" : "ex-row"}
        style={{ paddingLeft: 8 + (p.level - 1) * 14 }}
        title={item.title ? E.spoken(item.label, item.title) : item.label}
        data-row={item.id}
        onClick={() => p.onOpen(item.hash)}
      >
        {parent ? (
          <span
            className="ex-twisty"
            aria-hidden="true"
            data-twisty={item.id}
            onClick={(e) => {
              e.stopPropagation();
              p.onToggleItem(item.id);
            }}
          >
            <Chevron open={open} />
          </span>
        ) : (
          <span className="ex-twisty" aria-hidden="true" />
        )}
        <span className="ex-label">{item.label}</span>
        {item.kind && (
          <span className="ex-kind" aria-hidden="true">
            {E.kinds[item.kind]}
          </span>
        )}
        {item.waits && (
          <span className="ex-waits" aria-hidden="true">
            {E.waitsOnYou}
          </span>
        )}
        {item.detail && (
          <span className={item.waits ? "ex-detail waits" : "ex-detail"} aria-hidden="true">
            {item.detail}
          </span>
        )}
        {item.count !== undefined && (
          <span className="ex-count" aria-hidden="true">
            {E.count(item.count)}
          </span>
        )}
      </div>
      {open && (
        <ul role="group" className="ex-group">
          {p.rows
            .filter((r) => r.parent === item.id)
            .map((r) => (
              <TreeItem key={r.item.id} {...p} row={r} level={p.level + 1} />
            ))}
        </ul>
      )}
    </li>
  );
}

function SectionBody(p: ExplorerViewProps & { s: SectionModel; title: string }): JSX.Element {
  const { s } = p;
  if (s.state === "loading")
    return (
      <div className="ex-skel" role="status" aria-busy="true">
        <span className="sr">{E.loading(p.title)}</span>
        <span className="skeleton" style={{ width: "72%" }} />
        <span className="skeleton" style={{ width: "54%" }} />
        <span className="skeleton" style={{ width: "64%" }} />
      </div>
    );
  // Beta.27 review: the server down is said once, by the note above the page; each section says
  // quietly that it isn't loaded, and reads again when the server answers (useServerBack).
  if (s.state === "error" && (!s.error || isOffline(s.error)))
    return <p className="ex-state">{COPY.app.notLoadedOffline}</p>;
  if (s.state === "error")
    return (
      <div className="ex-state error" role="alert">
        <span>{E.couldntLoad(s.error ?? "")}</span>
        <button
          type="button"
          className="btn ex-retry"
          data-retry={s.id}
          onClick={() => p.onRetry(s.id)}
        >
          {E.retry}
        </button>
      </div>
    );
  if (!s.items.length)
    return (
      <p className="ex-state">
        {p.filter.trim()
          ? COPY.filter.nothingMatches(COPY.filter.words(p.filter.trim()))
          : E.empty[s.id]}
      </p>
    );
  const rows = visibleRows(s.id, s.items, p.expanded);
  const focused = p.focus[s.id];
  const tabStop = rows.some((r) => r.item.id === focused) ? focused : rows[0]?.item.id;
  return (
    <ul
      role="tree"
      aria-labelledby={`ex-head-${s.id}`}
      className="ex-tree"
      onKeyDown={(e) => p.onTreeKey(s.id, e)}
      onFocus={(e: FocusEvent<HTMLUListElement>) => {
        const id = (e.target as HTMLElement).dataset?.id;
        if (id) p.onTreeFocus(s.id, id);
      }}
    >
      {rows
        .filter((r) => r.level === 1)
        .map((r) => (
          <TreeItem
            key={r.item.id}
            row={r}
            rows={rows}
            tabStop={tabStop}
            expanded={p.expanded}
            current={p.current}
            level={1}
            onOpen={p.onOpen}
            onToggleItem={p.onToggleItem}
          />
        ))}
    </ul>
  );
}

/** The Explorer as drawn from its state: no hooks, so the shell's tests can render any state. */
export function ExplorerView(p: ExplorerViewProps): JSX.Element {
  const here = pageLabel(pinHash(p.current));
  return (
    // The shell's side panel is the landmark (its <aside> names it); this is what it holds.
    <div className="ex">
      <p className="ex-title" aria-hidden="true">
        {E.title}
      </p>
      <div className="ex-filter">
        <input
          type="search"
          className="field"
          aria-label={E.filter}
          placeholder={E.filterPlaceholder}
          autoComplete="off"
          value={p.filter}
          onChange={(e) => p.onFilter(e.target.value)}
        />
      </div>
      <div className="ex-scroll">
        {p.sections.map((s) => {
          const title = E.sections[s.id];
          return (
            <section key={s.id} className="ex-section" aria-labelledby={`ex-head-${s.id}`}>
              {/* The heading holds its fold button only; Pin stands beside it, so the heading's
                  name is the section's, not "Pinned Pin this page: …". */}
              <div className="ex-headrow">
                <h2 className="ex-head">
                  <button
                    type="button"
                    className="ex-head-btn"
                    aria-expanded={s.open}
                    aria-controls={`ex-body-${s.id}`}
                    onClick={() => p.onToggleSection(s.id)}
                  >
                    <Chevron open={s.open} />
                    <span id={`ex-head-${s.id}`} className="ex-head-name">
                      {title}
                    </span>
                    {s.count && <span className="ex-head-count">{s.count}</span>}
                  </button>
                </h2>
                {s.id === "pinned" && (
                  <button
                    id={PIN_BUTTON_ID}
                    type="button"
                    className="ex-pin"
                    aria-pressed={p.pinnedHere}
                    aria-label={E.pinHere(here)}
                    title={E.pinHere(here)}
                    onClick={p.onPinHere}
                  >
                    {E.pin}
                  </button>
                )}
              </div>
              <div id={`ex-body-${s.id}`} className="ex-body" hidden={!s.open}>
                {s.open && <SectionBody {...p} s={s} title={title} />}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

type Status = Pick<SectionModel, "state" | "error">;
/** A read's state as a section's: not asked yet is loading (it is asked as soon as it is open). */
/**
 * Beta.27 review: a metarepo whose manifest names no repo has no estate to ask for (it answers
 * 422, the catalog empty): the Systems section is empty without asking. Unknown yet, it asks.
 */
export const manifestEmpty = (m: ManifestReposAnswer | undefined): boolean =>
  m !== undefined && Array.isArray(m.repos) && m.repos.length === 0;

function statusOf(l: Lazy<unknown>, notYetIsEmpty = false): Status {
  if (l.state === "ready") return { state: "ready" };
  if (l.state === "error")
    return l.notYet && notYetIsEmpty ? { state: "ready" } : { state: "error", error: l.error };
  return { state: "loading" };
}

/**
 * Beta.27 review: the Systems header, in the manifest's repos (repo-counts.ts): all of them when
 * the map has a box for each, else how many of them it has; none until both reads are known.
 */
export function systemsHeader(c: RepoCounts | undefined): string | undefined {
  if (!c) return undefined;
  const head = c.onMap === c.repos ? E.repos(c.repos) : E.reposOnMap(c.onMap, c.repos);
  // Beta.27 re-review: boxes for repos the manifest doesn't name are said, never counted.
  const off = c.offManifest?.length ?? 0;
  return off ? E.alsoOffManifest(head, off) : head;
}

/**
 * The Explorer the shell shows. `current` is the active hash route; `onOpen(hash)` opens a page.
 * What it reads, and when: see explorer-data.ts.
 */
export function Explorer(props: { current: string; onOpen: (hash: string) => void }): JSX.Element {
  const { current, onOpen } = props;
  const [open, setOpen] = useState<Open>(readOpen);
  // A section the person opened reads at once; one open from the start waits for the page.
  const [touched, setTouched] = useState<ReadonlySet<SectionId>>(new Set());
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [focus, setFocus] = useState<Partial<Record<SectionId, string>>>({});
  const moved = useRef<string | undefined>(undefined);
  const filtering = filter.trim().length > 0;
  const want = (id: SectionId) => open[id] || filtering;
  const defer = (id: SectionId) => !touched.has(id) && !filtering;

  const changes = useLazyApi<ChangeRow[]>(CHANGES_PATH, want("changes"), defer("changes"));
  // Beta.27 review: the manifest's repos (Map › Trust's read, the status bar's too), so the
  // header and the tree count repos as the status bar does.
  const manifest = useKnownAnswer<ManifestReposAnswer>(
    MANIFEST_REPOS_PATH,
    want("systems"),
    manifestMayHaveChanged,
  );
  const noRepos = manifestEmpty(manifest);
  const estate = useLazyApi<{ children: EstateNode[] }>(
    ESTATE_PATH,
    want("systems") && !noRepos,
    defer("systems"),
  );
  const questions = useLazyApi<
    { questions: { repo: string; state?: string }[] } & StepQuestionsAnswer
  >(QUESTIONS_PATH, want("questions"), defer("questions"));
  const owner = useLazyApi<{ open: number }>(OWNER_PATH, want("questions"), defer("questions"));
  const repoCounts = repoCountsOf(manifest, estate.state === "ready" ? estate.data : undefined);
  const pins = usePins();

  // Beta.27 review: the server answering again reads the sections again (each said quietly that
  // it wasn't loaded while the server was down).
  useServerBack(() => {
    for (const s of [changes, estate, questions, owner]) if (s.state === "error") s.reload();
  });
  // What an assistant, the CLI or another page writes shows here without a reload.
  useFileChanges((events) => {
    const files = events.some((e) => e.type === "file.changed");
    if (catalogMayHaveChanged(events)) estate.reload();
    if (files || events.some((e) => e.type === "index.rebuilt")) changes.reload();
    if (files) {
      questions.reload();
      owner.reload();
    }
  });

  const all = useMemo(
    () => ({
      changes: changes.state === "ready" ? changeItems(changes.data) : [],
      systems:
        estate.state === "ready"
          ? systemItems(estate.data, repoCounts?.notOnMap ?? [], repoCounts?.offManifest ?? [])
          : [],
      questions:
        questions.state === "ready"
          ? questionItems(questions.data, owner.state === "ready" ? owner.data : undefined)
          : [],
      pinned: pinnedItems(pins, estateLabels(estate.state === "ready" ? estate.data : undefined)),
    }),
    [changes, estate, questions, owner, pins, manifest],
  );
  const shown = useMemo(() => {
    const out = {} as Record<SectionId, ExItem[]>;
    const forced = new Set<string>();
    for (const id of SECTION_IDS) {
      const f = filterItems(all[id], filter);
      out[id] = f.items;
      f.open.forEach((x) => forced.add(x));
    }
    return { items: out, open: new Set([...expanded, ...forced]) };
  }, [all, filter, expanded]);

  const status: Record<SectionId, Status> = {
    changes: statusOf(changes),
    systems: noRepos ? { state: "ready" } : statusOf(estate, true),
    questions:
      // The owner questions are a row of their own: the section waits on them, never fails by them.
      questions.state === "ready" && (owner.state === "idle" || owner.state === "loading")
        ? { state: "loading" }
        : statusOf(questions),
    pinned: { state: "ready" },
  };
  const counts: Record<SectionId, string | undefined> = {
    changes: changes.state === "ready" ? E.count(all.changes.length) : undefined,
    systems: systemsHeader(repoCounts),
    // Beta.27: the questions to answer, as the badge, the status bar and Home count them.
    questions: (() => {
      const q = questionsToAnswerOf(
        questions.state === "ready" ? questions.data : undefined,
        owner.state === "ready" ? owner.data : undefined,
      );
      return q ? E.count(q.total) : undefined;
    })(),
    pinned: undefined,
  };
  const sections: SectionModel[] = SECTION_IDS.map((id) => ({
    id,
    open: open[id] || filtering,
    ...status[id],
    items: shown.items[id],
    ...(counts[id] ? { count: counts[id] } : {}),
  }));

  // A key that moved the focus moves the browser's focus to the row (an element id), once it is
  // drawn: after an unpin, once the pins are read again.
  useEffect(() => {
    const id = moved.current;
    if (!id) return;
    moved.current = undefined;
    document.getElementById(id)?.focus();
  }, [focus, shown, pins]);

  const toggleItem = (id: string) =>
    setExpanded((x) => {
      const n = new Set(x);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <ExplorerView
      current={current}
      filter={filter}
      sections={sections}
      expanded={shown.open}
      focus={focus}
      pinnedHere={pins.includes(pinHash(current))}
      onFilter={setFilter}
      onToggleSection={(id) => {
        const next = { ...open, [id]: !open[id] };
        setOpen(next);
        saveOpen(next);
        setTouched((t) => new Set([...t, id]));
      }}
      onToggleItem={toggleItem}
      onOpen={onOpen}
      onRetry={(id) => {
        if (id === "changes") changes.reload();
        if (id === "systems") estate.reload();
        if (id === "questions") {
          questions.reload();
          owner.reload();
        }
      }}
      onPinHere={() => togglePin(current)}
      onTreeFocus={(id, itemId) => setFocus((f) => (f[id] === itemId ? f : { ...f, [id]: itemId }))}
      onTreeKey={(id, e) => {
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        const rows = visibleRows(id, shown.items[id], shown.open);
        const a = treeKey(rows, focus[id], e.key, shown.open);
        if (!a) return;
        e.preventDefault();
        if ("focus" in a) {
          moved.current = domId(a.focus);
          setFocus((f) => ({ ...f, [id]: a.focus }));
        } else if ("expand" in a || "collapse" in a)
          toggleItem("expand" in a ? a.expand : a.collapse);
        else if ("open" in a) onOpen(a.open);
        else {
          // The row after the one unpinned takes the focus (or the one before, at the end; with
          // none left, the section's Pin button).
          const at = rows.findIndex((r) => r.item.pin === a.unpin);
          const next = rows[at + 1] ?? rows[at - 1];
          moved.current = focusAfterUnpin(rows, a.unpin);
          togglePin(a.unpin);
          if (next) setFocus((f) => ({ ...f, [id]: next.item.id }));
        }
      }}
    />
  );
}
