import { useId, useState } from "react";
import type { Api } from "@maycombhq/core";
import { Propose } from "../../app/propose.js";
import { COPY } from "../../copy.js";
import { Note, useAction } from "../know/common.js";

/**
 * ADR 0190: "Edit, then Propose". Every setup form ends here: Preview the change shows the lines
 * the file would change (nothing written), Write it writes them, and then Propose for review
 * opens the PR with its own Yes (ADR 0183, 0186). Writing the metarepo's own file is local, so it
 * needs no confirmation, except where a raw edit moves where the model's key goes.
 */

const S = COPY.setup;
export type FileEdit = Api.FileEditViewT;

/** The lines an edit changes, as removed and added lines. */
export function DiffLines({ edit }: { edit: FileEdit }) {
  if (!edit.changes.length) return <p className="work-say">{S.nothingChanges}</p>;
  return (
    <ul
      aria-label={S.diffLabel(edit.path)}
      className="mono"
      style={{
        listStyle: "none",
        margin: 0,
        padding: 8,
        fontSize: 12,
        background: "var(--box)",
        border: "1px solid var(--line-2)",
        borderRadius: 8,
        maxHeight: 320,
        overflow: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
      }}
    >
      {edit.changes.flatMap((c, i) => [
        ...(c.was !== undefined
          ? [
              <li key={`${i}-was`} style={{ color: "var(--magenta-text)" }}>
                <span className="sr">{S.removed}: </span>
                {`- ${c.was}`}
              </li>,
            ]
          : []),
        ...(c.now !== undefined
          ? [
              <li key={`${i}-now`} style={{ color: "var(--green)" }}>
                <span className="sr">{S.added}: </span>
                {`+ ${c.now}`}
              </li>,
            ]
          : []),
      ])}
    </ul>
  );
}

export function EditPreview(p: {
  /** Asks the server for the lines the edit would change (`preview: true`). */
  preview: () => Promise<FileEdit>;
  /** Makes the write; `confirm` is set when the preview said the write needs the person's yes. */
  write: (confirm?: "ai-model") => Promise<FileEdit>;
  /** The form isn't ready (a required field is empty, or nothing is ticked). */
  disabled?: boolean;
  /** Told once the file is written (the page reads it again). */
  onWritten?: (e: FileEdit) => void;
  /** The button's words, when not Preview the change. */
  label?: string;
}) {
  const look = useAction();
  const send = useAction();
  const id = useId();
  const [plan, setPlan] = useState<FileEdit>();
  const [done, setDone] = useState<FileEdit>();
  if (done)
    return (
      <div className="stack" style={{ gap: 6 }}>
        <p role="status" className="work-say" style={{ margin: 0 }}>
          {`${S.written(done.path)} ${done.note}`}
        </p>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          {S.thenPropose}
        </p>
        <Propose scope="org-pack" />
      </div>
    );
  if (!plan)
    return (
      <div className="stack" style={{ gap: 4 }}>
        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className="btn"
            disabled={look.busy || p.disabled === true}
            onClick={() => void look.run(async () => setPlan(await p.preview()), "")}
          >
            {look.busy ? S.previewing : (p.label ?? S.preview)}
          </button>
        </div>
        {look.note && !look.note.ok && <Note note={look.note} />}
      </div>
    );
  return (
    <section className="stack" style={{ gap: 6 }} aria-labelledby={`${id}-t`}>
      <h4 id={`${id}-t`} className="hud" style={{ margin: 0, fontSize: 11 }}>
        {S.willChange(plan.path)}
      </h4>
      <DiffLines edit={plan} />
      {plan.confirm && (
        <p className="state" role="note" style={{ margin: 0 }}>
          {S.confirmAddress}
        </p>
      )}
      <div className="row" style={{ gap: 6 }}>
        <button
          type="button"
          className="btn primary"
          disabled={send.busy || !plan.changes.length}
          onClick={() =>
            void send.run(async () => {
              const e = await p.write(plan.confirm);
              setDone(e);
              p.onWritten?.(e);
              return e;
            }, S.written(plan.path))
          }
        >
          {send.busy ? S.writing : S.write}
        </button>
        <button type="button" className="btn" onClick={() => setPlan(undefined)}>
          {S.cancel}
        </button>
      </div>
      <Note note={send.note} />
    </section>
  );
}
