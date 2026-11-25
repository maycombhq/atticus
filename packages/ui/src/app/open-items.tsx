import { useId } from "react";
import { COPY } from "../copy.js";

const T = COPY.openItems;

/**
 * ADR 0210 part 7: the open items a hand-off goes ahead with, which its PR lists for the person who
 * approves it. Never a refusal: nothing here holds a button. Each is said once. With none, a quiet
 * list says nothing and the others say so; a server before the field (`items` absent) shows nothing.
 */
export function OpenItems(p: { items?: readonly { message: string }[]; quiet?: boolean }) {
  const id = useId();
  if (!p.items) return null;
  const list = [...new Set(p.items.map((i) => i.message))];
  if (!list.length)
    return p.quiet ? null : (
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        {T.none}
      </p>
    );
  return (
    <section aria-labelledby={id} className="stack" style={{ gap: 4 }}>
      <p id={id} className="cw-held" style={{ margin: 0 }}>
        <strong>{T.title}</strong>: {T.said(list.length)}
      </p>
      <ul className="cw-blockers" style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
        {list.map((m, i) => (
          <li key={i}>{m}</li>
        ))}
      </ul>
    </section>
  );
}
