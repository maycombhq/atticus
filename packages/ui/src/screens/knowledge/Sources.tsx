import { useState, type FormEvent } from "react";
import type { Api } from "@maycombhq/core";
import { api, useApi, useLiveEvents, type Loaded } from "../../api/client.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { message, Note, useAction } from "../know/common.js";
import { Problems } from "../work/RunNext.js";
import { AiStep, tagsOf } from "./shared.js";

/**
 * Knowledge sources (ADR 0102): the wikis in sources.yaml with their newest snapshot, Sync for
 * each (`atticus sources sync --source`), the form `atticus sources add … --save` takes, and
 * what the last knowledge scan changed. Reading a source with the AI is a step for the
 * assistant: the page gives its command and slash command to copy.
 */

const S = COPY.knowledge.sources;
const C = COPY.knowledge.scan;

type Source = Api.KnowledgeSourceT;

function SourceCard(p: {
  s: Source;
  staleDays: number;
  onSync: (id: string) => void;
  busy: boolean;
}) {
  const s = p.s;
  return (
    <article className="list-row" style={{ display: "block" }} aria-labelledby={`src-${s.id}`}>
      <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
        <h3 id={`src-${s.id}`} className="h" style={{ fontSize: 14, margin: 0 }}>
          {s.id}
        </h3>
        <span className="row" style={{ gap: 6 }}>
          {s.stale && <span className="chip warn">{S.stale(p.staleDays)}</span>}
          <button type="button" className="btn" disabled={p.busy} onClick={() => p.onSync(s.id)}>
            {p.busy ? S.syncing : S.sync(s.id)}
          </button>
        </span>
      </div>
      <dl className="run-facts" style={{ margin: "8px 0" }}>
        <dt>{S.type}</dt>
        <dd>{s.type}</dd>
        <dt>{S.location}</dt>
        <dd className="mono" style={{ wordBreak: "break-all" }}>
          {s.location}
        </dd>
        {s.ref && (
          <>
            <dt>{S.ref}</dt>
            <dd className="mono">{s.ref}</dd>
          </>
        )}
        {s.path && (
          <>
            <dt>{S.path}</dt>
            <dd className="mono">{s.path}</dd>
          </>
        )}
        {s.checkout && (
          <>
            <dt>{S.checkout}</dt>
            <dd>{s.checkout}</dd>
          </>
        )}
        <dt>{S.owner}</dt>
        <dd>{s.owner ?? "—"}</dd>
        <dt>{S.tags}</dt>
        <dd>
          {s.tags.kinds.length + s.tags.frameworks.length
            ? [...s.tags.kinds, ...s.tags.frameworks].join(", ")
            : S.noTags}
        </dd>
        <dt>{S.snapshot}</dt>
        <dd>
          {s.snapshot
            ? `${S.snapshotLine(s.snapshot.date, s.snapshot.pages, s.snapshot.ageDays)}${s.snapshot.commit ? `, ${S.commit(s.snapshot.commit)}` : ""}`
            : S.noSnapshot}
        </dd>
        <dt>{S.scanLabel}</dt>
        <dd>{s.scanned ? S.scanned(s.scanned.date) : S.notScanned}</dd>
      </dl>
      <AiStep command={s.commands.scan} slash={s.commands.slash} />
    </article>
  );
}

/** The sources, each with its snapshot and Sync; loading, error and empty states. */
export function SourceList(p: {
  of: Loaded<Api.KnowledgeSourceListT>;
  onSync: (id: string) => void;
  syncing?: string | undefined;
}) {
  return (
    <View of={p.of}>
      {(d) => (
        <>
          <Problems list={d.problems} />
          {d.sources.length === 0 ? (
            <div className="state">{S.empty}</div>
          ) : (
            d.sources.map((s) => (
              <SourceCard
                key={s.id}
                s={s}
                staleDays={d.staleDays}
                onSync={p.onSync}
                busy={p.syncing === s.id}
              />
            ))
          )}
        </>
      )}
    </View>
  );
}

export interface AddForm {
  type: string;
  location: string;
  id: string;
  path: string;
  ref: string;
  submodule: boolean;
  kinds: string;
  frameworks: string;
  owner: string;
  save: boolean;
}

export const EMPTY_ADD: AddForm = {
  type: "git",
  location: "",
  id: "",
  path: "",
  ref: "",
  submodule: false,
  kinds: "",
  frameworks: "",
  owner: "",
  save: true,
};

/** The body for POST /api/knowledge/sources, or what to fix first. */
export function addBody(f: AddForm): { body: Record<string, unknown> } | { error: string } {
  if (!f.location.trim()) return { error: S.needLocation };
  const git = f.type === "git";
  if (!git && (f.path.trim() || f.ref.trim() || f.submodule)) return { error: S.gitOnly };
  const kinds = tagsOf(f.kinds);
  if (!Array.isArray(kinds)) return kinds;
  const frameworks = tagsOf(f.frameworks);
  if (!Array.isArray(frameworks)) return frameworks;
  return {
    body: {
      type: f.type,
      location: f.location.trim(),
      ...(f.id.trim() ? { id: f.id.trim() } : {}),
      ...(git && f.path.trim() ? { path: f.path.trim() } : {}),
      ...(git && f.ref.trim() ? { ref: f.ref.trim() } : {}),
      ...(git && f.submodule ? { submodule: true } : {}),
      ...(kinds.length ? { kinds } : {}),
      ...(frameworks.length ? { frameworks } : {}),
      ...(f.owner.trim() ? { owner: f.owner.trim() } : {}),
      save: f.save,
    },
  };
}

function Text(p: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  list?: string;
}) {
  return (
    <div className="stack" style={{ gap: 4 }}>
      <label htmlFor={p.id} className="hud" style={{ fontSize: 10 }}>
        {p.label}
      </label>
      <input
        id={p.id}
        className="field"
        value={p.value}
        disabled={p.disabled}
        list={p.list}
        onChange={(e) => p.onChange(e.target.value)}
      />
    </div>
  );
}

/** The form `atticus sources add` takes. */
export function AddSource(p: {
  types: string[];
  kinds: string[];
  onAdded?: () => void;
  initial?: AddForm;
}) {
  const [f, setF] = useState<AddForm>(p.initial ?? EMPTY_ADD);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | undefined>();
  const set = (x: Partial<AddForm>) => setF((o) => ({ ...o, ...x }));
  const git = f.type === "git";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const b = addBody(f);
    if ("error" in b) {
      setNote({ ok: false, text: b.error });
      return;
    }
    setBusy(true);
    setNote(undefined);
    api<Api.CommandOutputT>("/api/knowledge/sources", { method: "POST", body: b.body })
      .then((r) => {
        // What the command printed: where it was written and what to run next, or the entry.
        setNote({ ok: true, text: r.lines.join("\n") });
        if (f.save) {
          setF(EMPTY_ADD);
          p.onAdded?.();
        }
      })
      .catch((x: unknown) => setNote({ ok: false, text: message(x) }))
      .finally(() => setBusy(false));
  };
  return (
    <form onSubmit={submit} className="stack" style={{ gap: 10 }} aria-labelledby="add-source">
      <p className="work-say">{S.addIntro}</p>
      <div className="stack" style={{ gap: 4 }}>
        <label htmlFor="src-type" className="hud" style={{ fontSize: 10 }}>
          {S.addType}
        </label>
        <select
          id="src-type"
          className="field"
          value={f.type}
          onChange={(e) => set({ type: e.target.value })}
        >
          {p.types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <Text
        id="src-location"
        label={S.addLocation}
        value={f.location}
        onChange={(v) => set({ location: v })}
      />
      <Text id="src-id" label={S.addId} value={f.id} onChange={(v) => set({ id: v })} />
      <Text
        id="src-path"
        label={S.addPath}
        value={f.path}
        disabled={!git}
        onChange={(v) => set({ path: v })}
      />
      <Text
        id="src-ref"
        label={S.addRef}
        value={f.ref}
        disabled={!git}
        onChange={(v) => set({ ref: v })}
      />
      <label className="row" style={{ gap: 8 }}>
        <input
          type="checkbox"
          checked={f.submodule}
          disabled={!git}
          onChange={(e) => set({ submodule: e.target.checked })}
        />
        {S.addSubmodule}
      </label>
      <Text
        id="src-kinds"
        label={S.addKinds}
        value={f.kinds}
        list="src-kind-list"
        onChange={(v) => set({ kinds: v })}
      />
      <datalist id="src-kind-list">
        {p.kinds.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
      <Text
        id="src-frameworks"
        label={S.addFrameworks}
        value={f.frameworks}
        onChange={(v) => set({ frameworks: v })}
      />
      <Text id="src-owner" label={S.addOwner} value={f.owner} onChange={(v) => set({ owner: v })} />
      <label className="row" style={{ gap: 8 }}>
        <input type="checkbox" checked={f.save} onChange={(e) => set({ save: e.target.checked })} />
        {S.addSave}
      </label>
      <div>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? S.adding : S.add}
        </button>
      </div>
      <Note note={note} />
    </form>
  );
}

function Ids({ label, ids }: { label: string; ids: string[] }) {
  if (!ids.length) return null;
  return (
    <div style={{ margin: "6px 0" }}>
      <span className="hud" style={{ fontSize: 10 }}>
        {label} ({ids.length})
      </span>
      <ul style={{ margin: "2px 0", paddingLeft: 18 }}>
        {ids.map((id) => (
          <li key={id}>
            <a href={`#/knowledge?item=${encodeURIComponent(id)}`} className="mono">
              {id}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the last scan changed, the reviews to check again, and the rescan to copy. */
export function ScanReport({ of }: { of: Loaded<Api.KnowledgeScanViewT> }) {
  return (
    <View of={of}>
      {(d) => (
        <div className="stack" style={{ gap: 8 }}>
          {!d.scannedAt ? (
            <div className="state">{C.never}</div>
          ) : (
            <>
              <p style={{ margin: 0 }}>{C.at(d.scannedAt.slice(0, 10))}</p>
              {d.changes &&
              d.changes.added.length + d.changes.changed.length + d.changes.removed.length ? (
                <>
                  <Ids label={C.added} ids={d.changes.added} />
                  <Ids label={C.changed} ids={d.changes.changed} />
                  <Ids label={C.removed} ids={d.changes.removed} />
                </>
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  {C.nothing}
                </p>
              )}
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                {C.flags(d.conflicts, d.injections, d.failed)}
              </p>
            </>
          )}
          <h3 className="hud" style={{ fontSize: 11, margin: "6px 0 0" }}>
            {C.checkAgain}
          </h3>
          {d.checkAgain.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              {C.noCheckAgain}
            </p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {d.checkAgain.map((c) => (
                <li key={c.id}>
                  <a href={`#/knowledge?item=${encodeURIComponent(c.id)}`}>{c.title}</a>{" "}
                  <span className="muted mono" style={{ fontSize: 11 }}>
                    {c.id} · {c.by}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <AiStep command={d.command} slash={d.slash} why={C.rescan} />
        </div>
      )}
    </View>
  );
}

export function KnowledgeSources() {
  const list = useApi<Api.KnowledgeSourceListT>("/api/knowledge/sources");
  const scan = useApi<Api.KnowledgeScanViewT>("/api/knowledge/scan");
  const [syncing, setSyncing] = useState<string | undefined>();
  const sync = useAction();
  useLiveEvents((e) => {
    if (e.type === "file.changed") {
      list.reload();
      scan.reload();
    }
  });
  const onSync = (id: string) => {
    setSyncing(id);
    void sync
      .run(
        () =>
          api<Api.CommandOutputT>(`/api/knowledge/sources/${encodeURIComponent(id)}/sync`, {
            method: "POST",
            body: {},
          }).then(list.reload),
        S.synced(id),
      )
      .finally(() => setSyncing(undefined));
  };
  return (
    <div className="bento">
      <Panel title={S.listTitle} span="span 7">
        <p className="work-say" style={{ marginTop: 0 }}>
          {S.intro}
        </p>
        <Note note={sync.note} />
        <SourceList of={list} onSync={onSync} syncing={syncing} />
      </Panel>
      <div className="column" style={{ gridColumn: "span 5" }}>
        <Panel title={C.title}>
          <ScanReport of={scan} />
        </Panel>
        <Panel title={S.addTitle} labelledBy="add-source">
          <View of={list}>
            {(d) => <AddSource types={d.types} kinds={d.kindSuggestions} onAdded={list.reload} />}
          </View>
        </Panel>
      </div>
    </div>
  );
}
