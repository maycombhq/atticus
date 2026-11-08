import { useId, useState } from "react";
import { api } from "../../api/client.js";
import { Propose } from "../../app/propose.js";
import { COPY } from "../../copy.js";
import { changeIdOf } from "../work/NewChange.js";
import { Note, useAction } from "./common.js";

const T = COPY.design;
const JOURNEYS = Object.keys(T.journeys);
const STATES = Object.keys(T.commitmentStates);
const focusOnShow = (el: HTMLElement | null) => el?.focus();

/**
 * UX review: an initiative starts in the app (POST /api/initiatives), as `atticus initiative
 * new` starts it, from a guided journey; the person signed in is who started it. After the
 * save, Propose for review (ADR 0183) offers its files.
 */
export function NewInitiative(p: { onCreated?: (id: string) => void; open?: boolean }) {
  const [open, setOpen] = useState(p.open ?? false);
  const [title, setTitle] = useState("");
  const [id, setId] = useState<string>();
  const [journey, setJourney] = useState(JOURNEYS[0]!);
  const [release, setRelease] = useState("");
  const [epic, setEpic] = useState("");
  const [saved, setSaved] = useState(false);
  const act = useAction();
  const uid = useId();
  // Seventh UX walk: after Start the form closes; what was started and Propose for review stay.
  if (!open)
    return (
      <div className="stack" style={{ gap: 8 }}>
        <div>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              setOpen(true);
              setSaved(false);
            }}
          >
            {T.newInitiative}
          </button>
        </div>
        {saved && (
          // The form's button is gone: focus moves to what was started (WCAG 2.4.3).
          <div ref={focusOnShow} tabIndex={-1} className="stack" style={{ gap: 8 }}>
            <Note note={act.note} />
            <Propose scope="initiatives" />
          </div>
        )}
      </div>
    );
  const theId = id ?? changeIdOf(title);
  const ready = title.trim() !== "" && theId !== "";
  const create = () =>
    void act.run(async () => {
      const r = await api<{ initiative: string; lines: string[] }>("/api/initiatives", {
        method: "POST",
        body: {
          title: title.trim(),
          id: theId,
          journey,
          ...(release ? { release } : {}),
          ...(epic.trim() ? { epic: epic.trim() } : {}),
        },
      });
      setSaved(true);
      setOpen(false);
      setTitle("");
      setId(undefined);
      setRelease("");
      setEpic("");
      p.onCreated?.(r.initiative);
      return r.initiative;
    }, T.startedInitiative);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <form
        className="stack"
        style={{ gap: 6 }}
        aria-label={T.newInitiativeTitle}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !act.busy) create();
        }}
      >
        <label htmlFor={`${uid}-title`} className="hud" style={{ fontSize: 10 }}>
          {T.initiativeTitleLabel}
        </label>
        <input
          id={`${uid}-title`}
          className="field"
          value={title}
          placeholder={T.initiativeTitleHint}
          onChange={(e) => {
            setTitle(e.target.value);
            setSaved(false);
          }}
        />
        <label htmlFor={`${uid}-id`} className="hud" style={{ fontSize: 10 }}>
          {T.initiativeIdLabel}
        </label>
        <input
          id={`${uid}-id`}
          className="field mono"
          value={theId}
          onChange={(e) => setId(e.target.value)}
        />
        <label htmlFor={`${uid}-journey`} className="hud" style={{ fontSize: 10 }}>
          {T.journeyLabel}
        </label>
        <select
          id={`${uid}-journey`}
          className="field"
          value={journey}
          onChange={(e) => setJourney(e.target.value)}
        >
          {JOURNEYS.map((j) => (
            <option key={j} value={j}>
              {T.journeys[j]}
            </option>
          ))}
        </select>
        <label htmlFor={`${uid}-release`} className="hud" style={{ fontSize: 10 }}>
          {T.releaseLabel}
        </label>
        <input
          id={`${uid}-release`}
          type="date"
          className="field mono"
          value={release}
          onChange={(e) => setRelease(e.target.value)}
        />
        <label htmlFor={`${uid}-epic`} className="hud" style={{ fontSize: 10 }}>
          {T.epicLabel}
        </label>
        <input
          id={`${uid}-epic`}
          className="field mono"
          value={epic}
          onChange={(e) => setEpic(e.target.value)}
        />
        <div className="row" style={{ gap: 6 }}>
          <button type="submit" className="btn primary" disabled={!ready || act.busy}>
            {act.busy ? T.startingInitiative : T.startInitiative}
          </button>
          <button type="button" className="btn" onClick={() => setOpen(false)}>
            {T.cancel}
          </button>
        </div>
        <Note note={act.note} />
      </form>
      {saved && <Propose scope="initiatives" />}
    </div>
  );
}

/**
 * Plan an initiative's changes and commitments (POST /api/initiatives/{id}/plan), as `atticus
 * initiative plan` does: back from the release, through the journey's steps.
 */
export function PlanInitiative(p: {
  initiative: string;
  planned?: boolean;
  release?: string | undefined;
  onSaved?: () => void;
}) {
  const [target, setTarget] = useState("");
  const [release, setRelease] = useState(p.release ?? "");
  const [systems, setSystems] = useState("");
  const [saved, setSaved] = useState(false);
  const act = useAction();
  const uid = useId();
  const others = systems
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ready = target.trim() !== "" || p.planned === true;
  const plan = () =>
    void act.run(async () => {
      await api(`/api/initiatives/${encodeURIComponent(p.initiative)}/plan`, {
        method: "POST",
        body: {
          ...(target.trim() ? { target: target.trim() } : {}),
          ...(release && release !== p.release ? { release } : {}),
          ...(others.length ? { systems: others } : {}),
        },
      });
      setSaved(true);
      p.onSaved?.();
    }, T.planned);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <form
        className="stack"
        style={{ gap: 6 }}
        aria-label={T.planTitle}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !act.busy) plan();
        }}
      >
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          {T.planSay}
        </p>
        <label htmlFor={`${uid}-target`} className="hud" style={{ fontSize: 10 }}>
          {T.targetLabel}
        </label>
        <input
          id={`${uid}-target`}
          className="field mono"
          value={target}
          placeholder={T.targetHint}
          onChange={(e) => setTarget(e.target.value)}
        />
        <label htmlFor={`${uid}-release`} className="hud" style={{ fontSize: 10 }}>
          {T.planReleaseLabel}
        </label>
        <input
          id={`${uid}-release`}
          type="date"
          className="field mono"
          value={release}
          onChange={(e) => setRelease(e.target.value)}
        />
        <label htmlFor={`${uid}-systems`} className="hud" style={{ fontSize: 10 }}>
          {T.systemsLabel}
        </label>
        <input
          id={`${uid}-systems`}
          className="field mono"
          value={systems}
          onChange={(e) => setSystems(e.target.value)}
        />
        <div className="row" style={{ gap: 6 }}>
          <button type="submit" className="btn primary" disabled={!ready || act.busy}>
            {act.busy ? T.planning : p.planned ? T.replan : T.plan}
          </button>
        </div>
        <Note note={act.note} />
      </form>
      {saved && <Propose scope="initiatives" />}
    </div>
  );
}

/**
 * Record where a commitment stands (POST /api/commitments/{id}/status), as `atticus initiative
 * commit` does, with a note kept beside the plan. The command is shown as the alternative.
 */
export function CommitmentState(p: {
  commitment: { id: string; what: string; recorded?: string };
  onSaved?: () => void;
}) {
  const [state, setState] = useState(p.commitment.recorded ?? STATES[0]!);
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState(false);
  const act = useAction();
  const uid = useId();
  const id = p.commitment.id;
  const record = () =>
    void act.run(
      async () => {
        await api(`/api/commitments/${encodeURIComponent(id)}/status`, {
          method: "POST",
          body: { status: state, ...(note.trim() ? { note: note.trim() } : {}) },
        });
        setSaved(true);
        setNote("");
        p.onSaved?.();
      },
      T.recorded(id, T.commitmentStates[state] ?? state),
    );
  return (
    <div className="stack" style={{ gap: 8 }}>
      <form
        className="stack"
        style={{ gap: 6 }}
        aria-label={T.setCommitment(p.commitment.what)}
        onSubmit={(e) => {
          e.preventDefault();
          if (!act.busy) record();
        }}
      >
        <label htmlFor={`${uid}-state`} className="hud" style={{ fontSize: 10 }}>
          {T.commitmentStateLabel}
        </label>
        <select
          id={`${uid}-state`}
          className="field"
          value={state}
          onChange={(e) => setState(e.target.value)}
        >
          {STATES.map((s) => (
            <option key={s} value={s}>
              {T.commitmentStates[s]}
            </option>
          ))}
        </select>
        <label htmlFor={`${uid}-note`} className="hud" style={{ fontSize: 10 }}>
          {T.noteLabel}
        </label>
        <textarea
          id={`${uid}-note`}
          className="field"
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="row" style={{ gap: 6 }}>
          <button type="submit" className="btn primary" disabled={act.busy}>
            {act.busy ? T.recording : T.recordState}
          </button>
        </div>
        <Note note={act.note} />
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          {T.orCommand}
          <span className="mono">{T.commitCommand(id)}</span>
        </p>
      </form>
      {saved && <Propose scope="initiatives" />}
    </div>
  );
}
