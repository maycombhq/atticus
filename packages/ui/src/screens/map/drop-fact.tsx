import { useId, useState } from "react";
import { api } from "../../api/client.js";
import { followJob } from "../../app/propose.js";
import { COPY } from "../../copy.js";
import { Note, useAction } from "../know/common.js";

const T = COPY.trust;

/**
 * App-only audit: one rejected fact held the whole repo (verify --write writes nothing while any
 * is rejected), and the app said only "Catalog from: Nothing yet". Drop this fact records the
 * person's correction that the fact is wrong, with their reason (a line in
 * facts/<repo>.corrections.jsonl, the same as Correct's), then runs Apply, which leaves it out
 * and writes the rest. Local files only; the correction is proposed for review like any other.
 */
export function DropFact(p: { repo: string; fact: string; onDone?: () => void }) {
  const act = useAction();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [missing, setMissing] = useState(false);
  const id = useId();
  if (!open)
    return (
      <button
        type="button"
        className="btn"
        aria-label={T.dropFactLabel(p.fact)}
        onClick={() => setOpen(true)}
      >
        {T.dropFact}
      </button>
    );
  return (
    <form
      className="stack"
      style={{ gap: 4, marginTop: 4 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!reason.trim()) {
          setMissing(true);
          return;
        }
        setMissing(false);
        void act.run(
          async () => {
            await api(`/api/facts/${encodeURIComponent(p.repo)}/corrections`, {
              method: "POST",
              body: { fact: p.fact, action: "wrong", reason: reason.trim() },
            });
            return followJob(`/api/facts/${encodeURIComponent(p.repo)}/apply`, {}).finally(() =>
              p.onDone?.(),
            );
          },
          () => T.droppedFact(p.fact),
        );
      }}
    >
      <label htmlFor={id}>{T.dropFactReason(p.fact)}</label>
      <input
        id={id}
        type="text"
        value={reason}
        aria-describedby={`${id}-help`}
        aria-invalid={missing || undefined}
        onChange={(e) => setReason(e.target.value)}
      />
      <span id={`${id}-help`} className="muted" style={{ fontSize: 12 }}>
        {missing ? T.dropFactNeedsReason : T.dropFactHelp}
      </span>
      <span className="row" style={{ gap: 6 }}>
        <button type="submit" className="btn primary" disabled={act.busy}>
          {act.busy ? T.droppingFact : T.dropFactAndApply}
        </button>
        <button type="button" className="btn" disabled={act.busy} onClick={() => setOpen(false)}>
          {T.dropFactCancel}
        </button>
      </span>
      <Note note={act.note} />
    </form>
  );
}
