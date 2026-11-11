import { useId, useState, type FormEvent } from "react";
import { api } from "../api/client.js";
import { COPY } from "../copy.js";
import { message } from "./run/shared.js";
import { ROLES, type Role } from "./RoleQuestions.js";
import "./questions.css";

/**
 * ADR 0191: a question goes to the role that answers it, by what it asks (business, design,
 * delivery). The AI tags it when it raises it; here a person sends it to another role (a business
 * question the architect was given goes to the product owner). The question keeps its answer.
 */

const W = COPY.roleWork;

/** What a question asks, as a chip's words; nothing for a level the page doesn't know. */
export function asksWords(asks: string | undefined): string | undefined {
  return asks ? W.asksChip(W.asks[asks] ?? asks) : undefined;
}

export function RouteQuestion(p: {
  id: string;
  /** The role it is for now. */
  role: string | undefined;
  /** What it asks (business, design, delivery). */
  asks?: string | undefined;
  /** A person moved it before: from which role, by whom, when. */
  routed?: { from?: string | undefined; by: string; at: string } | undefined;
  onRouted?: () => void;
}) {
  const id = useId();
  const [to, setTo] = useState<Role | "">("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | undefined>();
  const others = ROLES.filter((r) => r !== p.role);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!to) return;
    setBusy(true);
    setNote(undefined);
    try {
      await api(`/api/questions/${p.id}/route`, { method: "POST", body: { role: to } });
      setNote({ ok: true, text: W.routed(COPY.roles.who[to] ?? to) });
      setTo("");
      p.onRouted?.();
    } catch (x) {
      setNote({ ok: false, text: message(x) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="qs-route" onSubmit={submit}>
      {asksWords(p.asks) && <span className="chip">{asksWords(p.asks)}</span>}
      {p.routed && (
        <span className="qs-hint">
          {W.routedFrom(
            p.routed.from ? (COPY.roles.who[p.routed.from] ?? p.routed.from) : W.noRole,
            p.routed.by,
            p.routed.at.slice(0, 10),
          )}
        </span>
      )}
      <div className="qs-field">
        <label htmlFor={`${id}-to`} className="qs-field-label">
          {W.routeLabel}
        </label>
        <select
          id={`${id}-to`}
          className="field"
          value={to}
          onChange={(e) => setTo((e.target.value as Role) || "")}
        >
          <option value="">{W.routePick}</option>
          {others.map((r) => (
            <option key={r} value={r}>
              {COPY.roles.who[r] ?? r}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="btn" disabled={busy || !to}>
        {busy ? W.routing : W.route}
      </button>
      {note && (
        <p
          role={note.ok ? "status" : "alert"}
          className={`qs-route-note ${note.ok ? "muted" : "state error"}`}
          style={{ margin: 0 }}
        >
          {note.text}
        </p>
      )}
    </form>
  );
}
