import { useEffect, useRef, useState, type FormEvent, type Ref } from "react";
import type { Api } from "@maycombhq/core";
import { api, useApi, useReloadOnFiles, type Loaded } from "../../api/client.js";
import { escapeCloses, Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { Markdown, Note, useAction } from "../know/common.js";
import "./work.css";

/**
 * Eighth UX walk (API 2.76.0): where the feature lands, on Feature design. The feature stage
 * writes feature.yaml and draws feature.md from it (the feature in a few sentences, the flows it
 * touches, the gaps); the page shows feature.md, read-only, with who wrote it last: "Drafted by
 * AI" until a person saves it here. Edit opens feature.yaml, the source the stage's next run
 * reads; Save checks it still reads as a placement and draws feature.md again.
 */

const W = COPY.work;
type Placement = Api.PlacementViewT;

const day = (at: string | undefined) => (at ? at.slice(0, 10) : "");

/** Who wrote it last, as a chip and a line. */
function Drafted({ d }: { d: NonNullable<Placement["drafted"]> }) {
  if (d.by === "ai")
    return (
      <p className="work-say" style={{ margin: 0 }}>
        <span className="chip ai">{W.draftedByAi}</span> {W.draftedByAiWhy}
      </p>
    );
  return (
    <p className="work-say" style={{ margin: 0 }}>
      <span className="chip done">{d.who ? W.editedBy(d.who) : W.editedByPerson}</span>{" "}
      {d.who ? W.editedByWhy(d.who, day(d.at)) : W.editedByHand}
    </p>
  );
}

/** The panel from loaded data, so tests can render every state. */
export function PlacementView(p: {
  of: Loaded<Placement> & { reload?: () => void };
  onEdit?: () => void;
  /** The Edit button, so closing the editor puts the keyboard back on it. */
  editRef?: Ref<HTMLButtonElement>;
}) {
  const present = p.of.state === "ready" && p.of.data.present;
  return (
    <Panel
      title={W.placementTitle}
      span="1 / -1"
      meta={
        present && p.onEdit ? (
          <button
            ref={p.editRef}
            type="button"
            className="btn"
            aria-label={W.editPlacementLabel}
            onClick={p.onEdit}
          >
            {W.editPlacement}
          </button>
        ) : undefined
      }
    >
      <View
        of={p.of}
        empty={(d) => !d.present}
        emptyContent={<div className="state">{W.placementNotYet}</div>}
      >
        {(d) => (
          <div className="stack" style={{ gap: 8 }}>
            {d.drafted && <Drafted d={d.drafted} />}
            <span className="mono muted" style={{ fontSize: 11 }}>
              {d.file}
            </span>
            {d.content.trim() === "" ? (
              <div className="state">{W.placementNotDrawn}</div>
            ) : (
              <div
                tabIndex={0}
                role="region"
                aria-label={W.placementText}
                style={{ maxHeight: 520, overflowY: "auto", paddingRight: 6 }}
              >
                <Markdown text={d.content} />
              </div>
            )}
          </div>
        )}
      </View>
    </Panel>
  );
}

/** feature.yaml in a text box: Save (refused if it no longer reads as a placement), Cancel. */
function PlacementEditor(p: { change: string; d: Placement; onClose: (saved: boolean) => void }) {
  const [text, setText] = useState<string | undefined>();
  const [base, setBase] = useState(p.d.sha256);
  const act = useAction();
  const box = useRef<HTMLTextAreaElement>(null);
  const id = `placement-${p.change}`;
  useEffect(() => {
    box.current?.focus();
  }, []);
  const dirty = text !== undefined && text !== p.d.sourceContent;
  const close = () => p.onClose(false);
  return (
    <Panel title={W.placementEditTitle} span="1 / -1" meta={p.d.source}>
      <form
        className="stack"
        onKeyDown={escapeCloses(close)}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void act.run(async () => {
            const r = await api<Placement>(
              `/api/changes/${encodeURIComponent(p.change)}/placement`,
              { method: "PUT", body: { content: text ?? p.d.sourceContent, baseSha256: base } },
            );
            setBase(r.sha256);
            setText(undefined);
            p.onClose(true);
            return r;
          }, W.placementSaved);
        }}
      >
        <label htmlFor={id} className="sr">
          {W.placementSourceLabel}
        </label>
        <p id={`${id}-hint`} className="work-why" style={{ margin: 0 }}>
          {W.placementSourceHint}
        </p>
        <textarea
          ref={box}
          id={id}
          value={text ?? p.d.sourceContent}
          aria-describedby={`${id}-hint`}
          onChange={(e) => setText(e.target.value)}
          rows={18}
          spellCheck
          style={{
            width: "100%",
            background: "var(--box)",
            color: "var(--text)",
            border: "1px solid var(--line-2)",
            borderRadius: 8,
            padding: 12,
            font: "13px/1.6 var(--mono)",
          }}
        />
        <div className="row">
          <button type="submit" className="btn primary" disabled={act.busy}>
            {W.placementSave}
          </button>
          <button type="button" className="btn" onClick={close}>
            {dirty ? W.placementCancel : W.placementClose}
          </button>
        </div>
        <Note note={act.note} />
      </form>
    </Panel>
  );
}

/** The panel on Feature design: feature.md, and feature.yaml's editor on Edit. */
export function PlacementPanel({ change }: { change: string }) {
  const v = useApi<Placement>(`/api/changes/${encodeURIComponent(change)}/placement`);
  useReloadOnFiles(v);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const editBtn = useRef<HTMLButtonElement>(null);
  const was = useRef(false);
  // Closing the editor puts the keyboard back on Edit; a save says so beside it.
  useEffect(() => {
    if (!editing && was.current) editBtn.current?.focus();
    was.current = editing;
  }, [editing]);
  if (editing && v.state === "ready")
    return (
      <PlacementEditor
        change={change}
        d={v.data}
        onClose={(ok) => {
          setSaved(ok);
          setEditing(false);
          v.reload();
        }}
      />
    );
  return (
    <>
      <PlacementView
        of={v}
        editRef={editBtn}
        onEdit={() => {
          setSaved(false);
          setEditing(true);
        }}
      />
      {saved && (
        <p role="status" className="work-say" style={{ gridColumn: "1 / -1", margin: 0 }}>
          {W.placementSaved}
        </p>
      )}
    </>
  );
}
