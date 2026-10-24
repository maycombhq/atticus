import { useState } from "react";
import type { Api } from "@maycombhq/core";
import { api, useApi, useReloadOnFiles } from "../../api/client.js";
import { FilterBox, FilterCount, FilterEmpty } from "../../app/filter.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { Note, useAction } from "../know/common.js";
import { AiStep } from "./shared.js";

/**
 * The Documents tab (ADR 0122): the files in the metarepo's inputs/, which are general knowledge.
 * For each: what intake found it is, the systems it names, whether the knowledge source read it
 * (or why not), its age, and the knowledge items that quote it. Add files writes to
 * inputs/inbox/; Sync reads inputs/ into a snapshot; the knowledge scan is the assistant's step.
 */

const D = COPY.knowledge.documents;

type Doc = Api.DocumentViewT;

const DAY = 86_400_000;

/** How old a file is, in words, from its last change on disk. */
export function ageOf(modifiedAt: string | undefined, now: number): string | undefined {
  if (!modifiedAt) return undefined;
  const days = Math.floor((now - Date.parse(modifiedAt)) / DAY);
  return Number.isFinite(days) ? D.age(Math.max(0, days)) : undefined;
}

/** The documents a person's filters leave: by kind, by system, and by words in the path or title. */
export function filterDocuments(
  docs: Doc[],
  f: { kind: string; system: string; text: string },
): Doc[] {
  const t = f.text.trim().toLowerCase();
  return docs.filter(
    (d) =>
      (!f.kind || d.kind === f.kind) &&
      (!f.system || d.systems.includes(f.system)) &&
      (!t || d.path.toLowerCase().includes(t) || (d.title ?? "").toLowerCase().includes(t)),
  );
}

function DocumentRow({ d, now }: { d: Doc; now: number }) {
  const age = ageOf(d.modifiedAt, now);
  const verified = d.items.filter((i) => i.verified).length;
  return (
    <article className="list-row" style={{ display: "block" }} aria-label={d.path}>
      <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
        <span className="mono" style={{ wordBreak: "break-all" }}>
          {d.path}
        </span>
        <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <span className="chip">{D.kinds[d.kind] ?? d.kind}</span>
          <span className={`chip ${d.state === "read" ? "" : "warn"}`}>{D.states[d.state]}</span>
          {d.inbox && <span className="chip">{D.inbox}</span>}
        </span>
      </div>
      {d.title && d.title !== d.path && <p style={{ margin: "4px 0 0" }}>{d.title}</p>}
      <p className="muted" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
        {[
          d.systems.length ? D.systems(d.systems.join(", ")) : D.noSystems,
          age,
          d.items.length ? D.items(d.items.length, verified) : undefined,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {d.reason && (
        <p className="muted" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
          {D.why(d.reason)}
        </p>
      )}
      {d.supersededBy && !d.reason && (
        <p className="muted" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
          {D.newer(d.supersededBy)}
        </p>
      )}
      {d.duplicateOf && !d.reason && (
        <p className="muted" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
          {D.duplicate(d.duplicateOf)}
        </p>
      )}
      {d.items.length > 0 && (
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {d.items.map((i) => (
            <li key={i.id}>
              <a href={`#/knowledge?q=${encodeURIComponent(i.id)}`}>{i.title}</a>
              {i.verified ? ` (${D.verified})` : ""}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

/** The list with its filters; no fetching here, so it renders in tests. */
export function DocumentsView(p: { data: Api.DocumentListT; now?: number }) {
  const [kind, setKind] = useState("");
  const [system, setSystem] = useState("");
  const [text, setText] = useState("");
  const now = p.now ?? Date.now();
  const docs = p.data.documents;
  const kinds = [...new Set(docs.map((d) => d.kind))].sort();
  const systems = [...new Set(docs.flatMap((d) => d.systems))].sort();
  const shown = filterDocuments(docs, { kind, system, text });
  const active = !!(kind || system || text.trim());
  const read = docs.filter((d) => d.state === "read").length;
  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        {p.data.snapshot ? D.synced(p.data.snapshot.date, read, docs.length) : D.neverSynced}
      </p>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <FilterBox id="documents-filter" value={text} onChange={setText} grow />
        <label className="stack" style={{ gap: 2 }}>
          <span className="hud">{D.kindLabel}</span>
          <select
            id="documents-kind"
            className="field"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="">{D.anyKind}</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {D.kinds[k] ?? k}
              </option>
            ))}
          </select>
        </label>
        <label className="stack" style={{ gap: 2 }}>
          <span className="hud">{D.systemLabel}</span>
          <select
            id="documents-system"
            className="field"
            value={system}
            onChange={(e) => setSystem(e.target.value)}
          >
            <option value="">{D.anySystem}</option>
            {systems.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>
      <FilterCount shown={shown.length} total={docs.length} active={active} />
      {shown.length === 0 ? (
        <FilterEmpty
          what={D.filtered}
          onClear={() => {
            setKind("");
            setSystem("");
            setText("");
          }}
          focus="documents-filter"
        />
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          {shown.map((d) => (
            <DocumentRow key={d.path} d={d} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}

const base64 = (bytes: ArrayBuffer) => {
  let s = "";
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

export function Documents() {
  const list = useApi<Api.DocumentListT>("/api/knowledge/documents");
  useReloadOnFiles(list);
  const sync = useAction();
  const add = useAction();
  return (
    <div className="stack">
      <Panel title={D.title}>
        <p className="muted" style={{ margin: "0 0 8px", maxWidth: "70ch" }}>
          {D.intro}
        </p>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <label className="btn" htmlFor="documents-add">
            {add.busy ? D.adding : D.add}
          </label>
          <input
            id="documents-add"
            type="file"
            multiple
            className="sr"
            disabled={add.busy}
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              if (!files.length) return;
              void add.run(async () => {
                for (const f of files)
                  await api("/api/knowledge/documents", {
                    method: "POST",
                    body: { name: f.name, content: base64(await f.arrayBuffer()) },
                  });
                list.reload();
              }, D.added(files.length));
            }}
          />
          <button
            type="button"
            className="btn"
            disabled={sync.busy}
            onClick={() =>
              void sync.run(async () => {
                await api("/api/knowledge/sources/inputs/sync", { method: "POST" });
                list.reload();
              }, D.syncedNow)
            }
          >
            {sync.busy ? D.syncing : D.sync}
          </button>
        </div>
        <Note note={add.note} />
        <Note note={sync.note} />
      </Panel>
      <Panel title={D.listTitle}>
        <View of={list} empty={(d) => d.documents.length === 0} emptyText={D.empty}>
          {(d) => <DocumentsView data={d} />}
        </View>
      </Panel>
      <Panel title={D.readTitle}>
        <AiStep
          command="atticus knowledge scan --source inputs"
          slash="/atticus-knowledge inputs"
          why={D.readWhy}
        />
      </Panel>
    </div>
  );
}
