import { useId, useState } from "react";
import { api, useApi } from "../../api/client.js";
import { COPY } from "../../copy.js";
import { Note, useAction } from "../know/common.js";

const N = COPY.newChange;

/** A change id from its title: lower case, words joined by hyphens (what `change new` takes). */
export const changeIdOf = (title: string) =>
  title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");

/**
 * UX review: a change starts in the app (POST /api/changes), not only with `atticus change new`.
 * Title, id (from the title, editable) and type; Atticus writes the OpenSpec change and opens it.
 */
export function NewChange(p: { onCreated?: (id: string) => void; open?: boolean }) {
  const [open, setOpen] = useState(p.open ?? false);
  const [title, setTitle] = useState("");
  const [id, setId] = useState<string>();
  const [type, setType] = useState("");
  const types = useApi<{ id: string; name: string; description?: string }[]>(
    open ? "/api/change-types" : undefined,
  );
  const act = useAction();
  const uid = useId();
  if (!open)
    return (
      <button type="button" className="btn primary" onClick={() => setOpen(true)}>
        {N.start}
      </button>
    );
  const theId = id ?? changeIdOf(title);
  const list = types.state === "ready" ? types.data : [];
  const chosen = type || list[0]?.id || "";
  const ready = title.trim() !== "" && theId !== "" && chosen !== "";
  const create = () =>
    void act.run(async () => {
      await api("/api/changes", {
        method: "POST",
        body: { id: theId, title: title.trim(), type: chosen },
      });
      if (p.onCreated) p.onCreated(theId);
      else window.location.hash = `#/changes/${theId}`;
    }, N.created(theId));
  return (
    <form
      className="stack"
      style={{ gap: 6 }}
      aria-label={N.title}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !act.busy) create();
      }}
    >
      <label htmlFor={`${uid}-title`} className="hud" style={{ fontSize: 10 }}>
        {N.titleLabel}
      </label>
      <input
        id={`${uid}-title`}
        className="field"
        value={title}
        placeholder={N.titleHint}
        onChange={(e) => setTitle(e.target.value)}
      />
      <label htmlFor={`${uid}-id`} className="hud" style={{ fontSize: 10 }}>
        {N.idLabel}
      </label>
      <input
        id={`${uid}-id`}
        className="field mono"
        value={theId}
        onChange={(e) => setId(e.target.value)}
      />
      <label htmlFor={`${uid}-type`} className="hud" style={{ fontSize: 10 }}>
        {N.typeLabel}
      </label>
      {types.state === "error" ? (
        <p role="alert" className="state error">
          {N.noTypes(types.error)}
        </p>
      ) : (
        <select
          id={`${uid}-type`}
          className="field"
          value={chosen}
          aria-busy={types.state === "loading" ? true : undefined}
          onChange={(e) => setType(e.target.value)}
        >
          {list.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      <div className="row" style={{ gap: 6 }}>
        <button type="submit" className="btn primary" disabled={!ready || act.busy}>
          {act.busy ? N.starting : N.create}
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          {N.cancel}
        </button>
      </div>
      <Note note={act.note} />
    </form>
  );
}
