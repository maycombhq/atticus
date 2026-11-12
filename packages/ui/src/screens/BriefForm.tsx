import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api, ApiError, useApi } from "../api/client.js";
import { Panel, View } from "../app/ui.js";
import { COPY } from "../copy.js";
import { Markdown, Note, useAction } from "./know/common.js";
import { artifactUrl } from "./Changes.js";

/**
 * ADR 0191 (app-only audit, plain words for the product owner): the brief was a raw Markdown box
 * full of `<!-- … -->` comments under its file path. Here it is a form: one box per section of
 * brief.md, the section's comment as the box's hint, and Save writes the same brief.md (a section
 * left as it was is written byte for byte as it was). The file's path is under Details.
 */

const B = COPY.roleWork.brief;

export interface BriefSection {
  heading: string;
  /** The template's comment(s) in the section: the box's hint. */
  hint: string;
  /** The section's text, comments aside. */
  text: string;
  /** The section's lines as they are in the file (heading aside), written back when unchanged. */
  raw: string;
}

export interface BriefDoc {
  /** Everything before the first `## ` (the title and the opening comment), kept as it is. */
  head: string;
  sections: BriefSection[];
}

const COMMENT = /<!--([\s\S]*?)-->/g;

/** brief.md read into its sections: each `## ` heading with its hint and its text. */
export function parseBrief(md: string): BriefDoc {
  const text = md.replace(/\r\n/g, "\n");
  const parts = text.split(/^## /m);
  const head = parts.shift() ?? "";
  return {
    head,
    sections: parts.map((p) => {
      const nl = p.indexOf("\n");
      const heading = (nl < 0 ? p : p.slice(0, nl)).trim();
      const raw = nl < 0 ? "" : p.slice(nl + 1);
      const hint = [...raw.matchAll(COMMENT)]
        .map((m) => m[1]!.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(" ");
      return { heading, hint, text: raw.replace(COMMENT, "").trim(), raw };
    }),
  };
}

/**
 * The brief written back: a section whose text is as it was keeps its lines; an edited one is its
 * heading, its hint as a comment (so the next person sees what it asks), and the new text.
 */
export function renderBrief(doc: BriefDoc, texts: Readonly<Record<number, string>>): string {
  return (
    doc.head +
    doc.sections
      .map((s, i) => {
        const t = texts[i];
        if (t === undefined || t.trim() === s.text) return `## ${s.heading}\n${s.raw}`;
        const body = [s.hint ? `<!-- ${s.hint} -->` : "", t.trim()].filter(Boolean).join("\n\n");
        return `## ${s.heading}\n\n${body}\n\n`;
      })
      .join("")
  ).replace(/\n{3,}$/, "\n\n");
}

interface Artifact {
  path: string;
  content: string;
  sha256: string;
}

/**
 * Beta.27 review: a brief being edited, kept while the person is on another page (Brief, Edit,
 * type, Questions, Back showed the saved text, the draft only after Edit again). In memory only,
 * for this page load, as the shell keeps a tab's fields; never written to storage.
 */
export const briefDrafts = new Map<string, Record<number, string>>();

export function BriefForm({ change, onSaved }: { change: string; onSaved?: () => void }) {
  const id = useId();
  const a = useApi<Artifact>(artifactUrl(change, "brief"));
  const kept = briefDrafts.get(change);
  const [editing, setEditing] = useState(() => !!kept);
  const [texts, setTexts] = useState<Record<number, string>>(() => kept ?? {});
  const [restored] = useState(() => !!kept);
  // What is typed is kept when the page is left with the editor open; Save and Cancel drop it.
  const now = useRef({ editing, texts });
  now.current = { editing, texts };
  useEffect(
    () => () => {
      const { editing: open, texts: t } = now.current;
      if (open && Object.keys(t).length) briefDrafts.set(change, t);
      else briefDrafts.delete(change);
    },
    [change],
  );
  const [changed, setChanged] = useState(false);
  const act = useAction();
  const editBtn = useRef<HTMLButtonElement>(null);
  return (
    <Panel
      title={B.title}
      meta={
        !editing && a.state === "ready" ? (
          <button ref={editBtn} type="button" className="btn" onClick={() => setEditing(true)}>
            {a.data.content.trim() ? B.edit : B.write}
          </button>
        ) : undefined
      }
    >
      <View of={a}>
        {(d) => {
          const doc = parseBrief(d.content);
          if (!editing)
            return (
              <div className="stack" style={{ gap: 10 }}>
                {doc.sections.length === 0 && <div className="state">{B.empty}</div>}
                {doc.sections.map((s) => (
                  <section
                    key={s.heading}
                    aria-label={s.heading}
                    className="stack"
                    style={{ gap: 2 }}
                  >
                    <h3 className="hud" style={{ margin: 0, fontSize: 11 }}>
                      {s.heading}
                    </h3>
                    {s.text ? (
                      <Markdown text={s.text} />
                    ) : (
                      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                        {s.hint || B.empty}
                      </p>
                    )}
                  </section>
                ))}
                <details>
                  <summary className="muted" style={{ fontSize: 12 }}>
                    {B.details}
                  </summary>
                  <p className="mono muted" style={{ margin: "4px 0 0", fontSize: 11 }}>
                    {B.file(d.path)}
                  </p>
                </details>
              </div>
            );
          const submit = (e: FormEvent) => {
            e.preventDefault();
            setChanged(false);
            void act.run(
              () =>
                api(artifactUrl(change, "brief"), {
                  method: "PUT",
                  body: { content: renderBrief(doc, texts), baseSha256: d.sha256 },
                })
                  .then(() => {
                    briefDrafts.delete(change);
                    setEditing(false);
                    setTexts({});
                    a.reload();
                    onSaved?.();
                    editBtn.current?.focus();
                  })
                  .catch((x: unknown) => {
                    if (x instanceof ApiError && x.problem.status === 409) setChanged(true);
                    throw x;
                  }),
              B.saved,
            );
          };
          return (
            <form className="stack" style={{ gap: 12 }} onSubmit={submit}>
              <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                {B.intro}
              </p>
              {restored && Object.keys(texts).length > 0 && (
                <p role="status" className="work-say" style={{ margin: 0 }}>
                  {B.draftKept}
                </p>
              )}
              {doc.sections.map((s, i) => (
                <div key={s.heading} className="stack" style={{ gap: 4 }}>
                  <label htmlFor={`${id}-${i}`} className="hud" style={{ fontSize: 11 }}>
                    {s.heading}
                  </label>
                  <textarea
                    id={`${id}-${i}`}
                    className="field"
                    rows={Math.max(3, Math.min(10, (texts[i] ?? s.text).split("\n").length + 1))}
                    value={texts[i] ?? s.text}
                    {...(s.hint ? { "aria-describedby": `${id}-${i}-hint` } : {})}
                    onChange={(e) => setTexts((t) => ({ ...t, [i]: e.target.value }))}
                    spellCheck
                    style={{ width: "100%" }}
                  />
                  {s.hint && (
                    <span id={`${id}-${i}-hint`} className="muted" style={{ fontSize: 12 }}>
                      {s.hint}
                    </span>
                  )}
                </div>
              ))}
              {changed && (
                <p role="alert" className="state error" style={{ margin: 0 }}>
                  {B.changed}
                </p>
              )}
              <div className="row" style={{ gap: 6 }}>
                <button type="submit" className="btn primary" disabled={act.busy}>
                  {act.busy ? B.saving : B.save}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    briefDrafts.delete(change);
                    setEditing(false);
                    setTexts({});
                  }}
                >
                  {B.cancel}
                </button>
              </div>
            </form>
          );
        }}
      </View>
      {/* What Save said stays when the form closes on it. */}
      <Note note={act.note} />
    </Panel>
  );
}
