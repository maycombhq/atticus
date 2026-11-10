import { useEffect, useId, useState, type FormEvent } from "react";
import type { Api } from "@maycombhq/core";
import { api, useApi } from "../api/client.js";
import { COPY } from "../copy.js";
import { Note, useAction } from "./know/common.js";

/**
 * Ninth UX walk (API 2.83.0): name a change's owners per role on its page: the product owner, the
 * architect, the business analyst and the tech lead. Saving writes change.yaml's `owners` through
 * the change store, on the person's click; Home and Questions then know whose questions are whose.
 * Words, not permissions: anyone can still answer any question.
 *
 * ADR 0191 (app-only audit): a new change named only its creator, so Home asked "Pick a role". The
 * people roles.yaml suggests for each role (the team that owns the change's repos, else the
 * organisation's default) are offered, each accepted with one click; nothing is written by
 * itself. The form opens on Change who is on it, so the page has one Save at a time (it had
 * "Save owners" beside the editor's Save).
 */

const O = COPY.changeOwners;
const W = COPY.roleWork;

export const OWNER_ROLES = ["product-owner", "architect", "business-analyst", "team-lead"] as const;
export type OwnerRole = (typeof OWNER_ROLES)[number];

/** The form's text for each role: the handles change.yaml names, comma-separated. */
export function ownersFields(
  owners: Readonly<Record<string, readonly string[]>> | undefined,
): Record<OwnerRole, string> {
  return Object.fromEntries(OWNER_ROLES.map((r) => [r, (owners?.[r] ?? []).join(", ")])) as Record<
    OwnerRole,
    string
  >;
}

/** The request body for the fields: each role's handles, split on commas and spaces. */
export function ownersBody(fields: Readonly<Record<OwnerRole, string>>): {
  owners: Record<OwnerRole, string[]>;
} {
  return {
    owners: Object.fromEntries(
      OWNER_ROLES.map((r) => [
        r,
        [
          ...new Set(
            (fields[r] ?? "")
              .split(/[,\s]+/)
              .map((h) => h.trim())
              .filter(Boolean),
          ),
        ],
      ]),
    ) as Record<OwnerRole, string[]>,
  };
}

/**
 * The body that accepts a suggestion: the role's owners as they are, with its people added. Only
 * that role (ADR 0191 review): the route names the roles a body gives and clears one given empty,
 * so sending every role from the page's copy could clear an owner someone named since it loaded.
 */
export function acceptBody(
  owners: Readonly<Record<string, readonly string[]>> | undefined,
  s: { role: string; people: readonly string[] },
): { owners: Record<string, string[]> } {
  return { owners: { [s.role]: [...new Set([...(owners?.[s.role] ?? []), ...s.people])] } };
}

/** Where a suggestion comes from, in words. */
export function suggestionFrom(s: Api.OwnerSuggestionListT["suggestions"][number]): string {
  return "team" in s.from
    ? W.suggestedFromTeam(s.from.name ?? s.from.team, s.from.repos.join(", "))
    : W.suggestedDefault;
}

export function ChangeOwners(p: {
  change: string;
  owners: Readonly<Record<string, readonly string[]>> | undefined;
  onSaved?: () => void;
  /** Tests: open the form at once. */
  startEditing?: boolean;
}) {
  const id = useId();
  const [editing, setEditing] = useState(p.startEditing === true);
  // The owners as last saved here, so a second Accept never writes over the first before the
  // page reads the change again.
  const [owners, setOwners] = useState(p.owners);
  const given = JSON.stringify(p.owners ?? {});
  useEffect(() => setOwners(JSON.parse(given) as typeof p.owners), [given]);
  const [fields, setFields] = useState(() => ownersFields(p.owners));
  const save = useAction();
  const accept = useAction();
  const suggested = useApi<Api.OwnerSuggestionListT>(
    `/api/changes/${encodeURIComponent(p.change)}/owners/suggested`,
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save.run(
      () =>
        api(`/api/changes/${encodeURIComponent(p.change)}/owners`, {
          method: "PUT",
          body: ownersBody(fields),
        }).then(() => {
          setEditing(false);
          suggested.reload();
          p.onSaved?.();
        }),
      O.saved,
    );
  };
  const suggestions = suggested.state === "ready" ? suggested.data.suggestions : [];
  return (
    <section className="stack" style={{ gap: 6 }} aria-labelledby={`${id}-h`}>
      <p id={`${id}-h`} className="hud" style={{ margin: 0 }}>
        {W.ownersTitle}
      </p>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        {W.ownersIntro}
      </p>
      {!editing && (
        <>
          <dl className="row" style={{ gap: 16, flexWrap: "wrap", margin: 0 }}>
            {OWNER_ROLES.map((r) => (
              <div key={r} className="stack" style={{ gap: 2, minWidth: 140 }}>
                <dt className="hud" style={{ fontSize: 10 }}>
                  {O.roles[r]}
                </dt>
                <dd style={{ margin: 0, fontSize: 13 }}>
                  {(owners?.[r] ?? []).length ? (owners?.[r] ?? []).join(", ") : W.nobody}
                </dd>
              </div>
            ))}
          </dl>
          {suggestions.length > 0 && (
            <div className="stack" style={{ gap: 4 }}>
              <p className="hud" style={{ margin: 0, fontSize: 10 }}>
                {W.suggestedTitle}
              </p>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }} className="stack">
                {suggestions.map((s) => {
                  const who = s.people.join(", ");
                  const role = W.roleNames[s.role] ?? s.role;
                  return (
                    <li
                      key={`${s.role}|${who}`}
                      className="row"
                      style={{ gap: 8, flexWrap: "wrap" }}
                    >
                      <span style={{ fontSize: 13 }}>
                        {O.roles[s.role] ?? s.role}: <strong>{who}</strong>{" "}
                        <span className="muted">({suggestionFrom(s)})</span>
                      </span>
                      <button
                        type="button"
                        className="btn"
                        disabled={accept.busy}
                        aria-label={W.acceptFor(who, role)}
                        onClick={() =>
                          void accept.run(
                            () => {
                              const body = acceptBody(owners, s);
                              return api<{ owners?: Record<string, string[]> }>(
                                `/api/changes/${encodeURIComponent(p.change)}/owners`,
                                { method: "PUT", body },
                              ).then((c) => {
                                // The owners as written, every role's (the body has one).
                                setOwners(c?.owners ?? { ...owners, ...body.owners });
                                suggested.reload();
                                p.onSaved?.();
                              });
                            },
                            W.accepted(who, role),
                          )
                        }
                      >
                        {W.accept}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <Note note={accept.note} />
          <div className="row" style={{ gap: 6 }}>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setFields(ownersFields(owners));
                setEditing(true);
              }}
            >
              {W.editOwners}
            </button>
          </div>
          <Note note={save.note} />
        </>
      )}
      {editing && (
        <form className="stack" style={{ gap: 6 }} onSubmit={submit}>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {OWNER_ROLES.map((r) => (
              <div key={r} className="stack" style={{ gap: 2, minWidth: 160 }}>
                <label htmlFor={`${id}-${r}`} className="hud" style={{ fontSize: 10 }}>
                  {O.roles[r]}
                </label>
                <input
                  id={`${id}-${r}`}
                  className="field"
                  value={fields[r]}
                  placeholder={O.placeholder}
                  onChange={(e) => setFields((f) => ({ ...f, [r]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button type="submit" className="btn" disabled={save.busy}>
              {save.busy ? O.saving : W.saveOwners}
            </button>
            <button type="button" className="btn" onClick={() => setEditing(false)}>
              {W.cancelOwners}
            </button>
          </div>
          <Note note={save.note} />
        </form>
      )}
    </section>
  );
}
