import { useId, useState, type FormEvent } from "react";
import { api } from "../api/client.js";
import { COPY } from "../copy.js";
import { Note, useAction } from "./know/common.js";

/**
 * Ninth UX walk (API 2.83.0): name a change's owners per role on its page: the product owner, the
 * architect, the business analyst and the tech lead. Saving writes change.yaml's `owners` through
 * the change store, on the person's click; Home and Questions then know whose questions are whose.
 * Words, not permissions: anyone can still answer any question.
 */

const O = COPY.changeOwners;

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

export function ChangeOwners(p: {
  change: string;
  owners: Readonly<Record<string, readonly string[]>> | undefined;
  onSaved?: () => void;
}) {
  const id = useId();
  const [fields, setFields] = useState(() => ownersFields(p.owners));
  const save = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save.run(
      () =>
        api(`/api/changes/${encodeURIComponent(p.change)}/owners`, {
          method: "PUT",
          body: ownersBody(fields),
        }).then(() => p.onSaved?.()),
      O.saved,
    );
  };
  return (
    <form className="stack" style={{ gap: 6 }} onSubmit={submit} aria-labelledby={`${id}-h`}>
      <p id={`${id}-h`} className="hud" style={{ margin: 0 }}>
        {O.title}
      </p>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        {O.intro}
      </p>
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
          {save.busy ? O.saving : O.save}
        </button>
      </div>
      <Note note={save.note} />
    </form>
  );
}
