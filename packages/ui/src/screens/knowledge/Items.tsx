import { useState, type FormEvent } from "react";
import type { Api } from "@maycombhq/core";
import { api, useApi, useLiveEvents, type Loaded } from "../../api/client.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { message, Note, queryParam } from "../know/common.js";
import { Problems } from "../work/RunNext.js";
import {
  correctionBody,
  fieldLabel,
  formOf,
  groupItems,
  kindLabel,
  Links,
  matchItem,
  quoteOf,
  ReviewChip,
  reviewText,
  urlsOf,
  valueText,
  where,
  type FormValue,
  NoKnowledgeYet,
  type Item,
  type Link,
} from "./shared.js";

/**
 * Knowledge items (ADR 0102): what the knowledge scan read, grouped by kind, searchable, each
 * with its fields, quote, page and links, and its review. Verify, Correct (only the fields its
 * record kind allows) and Reject (with the reason) write knowledge/reviews/<id>.yaml as the
 * signed-in person, as atticus knowledge verify, correct and reject do.
 */

const K = COPY.knowledge;
const I = K.items;

/** The fields shown for an item besides those a person may correct. */
const SHOWN = ["decision", "stance"];

/** The list: grouped by kind, filtered by the search and the kind picked. */
export function ItemList(p: {
  of: Loaded<Api.KnowledgeItemListT>;
  text: string;
  kind: string;
  current?: string | undefined;
  screen?: string;
}) {
  const screen = p.screen ?? "knowledge";
  return (
    <View
      of={p.of}
      empty={(d) => d.items.length === 0}
      emptyContent={<NoKnowledgeYet text={I.empty} />}
    >
      {(d) => {
        const shown = d.items.filter((i) => (!p.kind || i.kind === p.kind) && matchItem(i, p.text));
        const groups = groupItems(shown, K.groups);
        return (
          <>
            <Problems list={d.problems} />
            <p className="hud" style={{ fontSize: 10, margin: "0 0 6px" }} aria-live="polite">
              {I.count(shown.length)}
            </p>
            {groups.length === 0 && <div className="state">{I.noMatch}</div>}
            {groups.map((g) => (
              <section key={g.title} aria-label={g.title} style={{ marginBottom: 10 }}>
                <h3 className="hud" style={{ fontSize: 11, margin: "6px 0" }}>
                  {`${g.title} (${g.items.length})`}
                </h3>
                <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {g.items.map((i) => (
                    <li key={i.id} className="list-row" style={{ alignItems: "flex-start" }}>
                      <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                        <a
                          href={`#/${screen}?item=${encodeURIComponent(i.id)}`}
                          aria-current={i.id === p.current ? "true" : undefined}
                        >
                          {i.title}
                        </a>
                        <span className="muted mono" style={{ fontSize: 11 }}>
                          {kindLabel(i.kind)} · {i.id}
                        </span>
                      </span>
                      <ReviewChip review={i.review} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </>
        );
      }}
    </View>
  );
}

function TextField(p: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="stack" style={{ gap: 4 }}>
      <label htmlFor={p.id} className="hud" style={{ fontSize: 10 }}>
        {p.label}
      </label>
      <input
        id={p.id}
        className="field"
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
      />
    </div>
  );
}

/** A list edited as a list: one box per entry, Remove for each, and Add one. */
function ListField(p: {
  id: string;
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <fieldset className="stack" style={{ gap: 4, border: 0, padding: 0, margin: 0 }}>
      <legend className="hud" style={{ fontSize: 10 }}>
        {p.label}
      </legend>
      {p.value.map((v, n) => (
        <div key={n} className="row" style={{ gap: 6 }}>
          <input
            className="field"
            aria-label={`${p.label}: ${I.item(n + 1)}`}
            value={v}
            onChange={(e) => p.onChange(p.value.map((x, j) => (j === n ? e.target.value : x)))}
          />
          <button
            type="button"
            className="btn"
            aria-label={`${I.remove} ${p.label}: ${I.item(n + 1)}`}
            onClick={() => p.onChange(p.value.filter((_, j) => j !== n))}
          >
            {I.remove}
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          className="btn"
          aria-label={`${I.addValue}: ${p.label}`}
          onClick={() => p.onChange([...p.value, ""])}
        >
          {I.addValue}
        </button>
      </div>
    </fieldset>
  );
}

/** Links edited as label and address, one row each. */
function LinksField(p: {
  id: string;
  label: string;
  value: Link[];
  onChange: (v: Link[]) => void;
}) {
  const set = (n: number, x: Partial<Link>) =>
    p.onChange(p.value.map((l, j) => (j === n ? { ...l, ...x } : l)));
  return (
    <fieldset className="stack" style={{ gap: 4, border: 0, padding: 0, margin: 0 }}>
      <legend className="hud" style={{ fontSize: 10 }}>
        {p.label}
      </legend>
      {p.value.map((l, n) => (
        <div key={n} className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <input
            className="field"
            style={{ flex: "1 1 120px" }}
            aria-label={`${I.link(n + 1)}: ${I.linkLabel}`}
            placeholder={I.linkLabel}
            value={l.label ?? ""}
            onChange={(e) => set(n, { label: e.target.value })}
          />
          <input
            className="field"
            style={{ flex: "2 1 220px" }}
            aria-label={`${I.link(n + 1)}: ${I.linkUrl}`}
            placeholder={I.linkUrl}
            value={l.url}
            onChange={(e) => set(n, { url: e.target.value })}
          />
          <button
            type="button"
            className="btn"
            aria-label={`${I.remove} ${I.link(n + 1)}`}
            onClick={() => p.onChange(p.value.filter((_, j) => j !== n))}
          >
            {I.remove}
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          className="btn"
          aria-label={`${I.addValue}: ${p.label}`}
          onClick={() => p.onChange([...p.value, { url: "", label: "" }])}
        >
          {I.addValue}
        </button>
      </div>
    </fieldset>
  );
}

/** The correction form: only the fields the item's record kind allows. */
export function CorrectForm(p: {
  item: Item;
  onSave: (set: Record<string, FormValue>) => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const [form, setForm] = useState<Record<string, FormValue>>(() => formOf(p.item));
  const [err, setErr] = useState<string | undefined>();
  const set = (f: string, v: FormValue) => setForm((o) => ({ ...o, [f]: v }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const b = correctionBody(p.item, form);
    if ("error" in b) {
      setErr(b.error);
      return;
    }
    setErr(undefined);
    p.onSave(b.set);
  };
  const base = `fix-${p.item.id}`;
  return (
    <form onSubmit={submit} className="stack" style={{ gap: 10 }} aria-label={I.correct}>
      <p className="work-say">{I.correctIntro}</p>
      {Object.entries(p.item.fields).map(([f, t]) =>
        t === "text" ? (
          <TextField
            key={f}
            id={`${base}-${f}`}
            label={fieldLabel(f)}
            value={form[f] as string}
            onChange={(v) => set(f, v)}
          />
        ) : t === "list" ? (
          <ListField
            key={f}
            id={`${base}-${f}`}
            label={fieldLabel(f)}
            value={form[f] as string[]}
            onChange={(v) => set(f, v)}
          />
        ) : (
          <LinksField
            key={f}
            id={`${base}-${f}`}
            label={fieldLabel(f)}
            value={form[f] as Link[]}
            onChange={(v) => set(f, v)}
          />
        ),
      )}
      <div className="row" style={{ gap: 8 }}>
        <button type="submit" className="btn primary" disabled={p.busy}>
          {p.busy ? I.saving : I.save}
        </button>
        <button type="button" className="btn" onClick={p.onCancel}>
          {I.cancel}
        </button>
      </div>
      {err && (
        <p role="alert" style={{ margin: 0, color: "var(--magenta-text)", fontSize: 12.5 }}>
          {err}
        </p>
      )}
    </form>
  );
}

/** The reason a person rejects an item for; required. */
function RejectForm(p: { onSave: (note: string) => void; onCancel: () => void; busy?: boolean }) {
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | undefined>();
  return (
    <form
      className="stack"
      style={{ gap: 8 }}
      aria-label={I.reject}
      onSubmit={(e) => {
        e.preventDefault();
        if (!note.trim()) {
          setErr(I.needWhy);
          return;
        }
        p.onSave(note.trim());
      }}
    >
      <label htmlFor="reject-why" className="hud" style={{ fontSize: 10 }}>
        {I.rejectWhy}
      </label>
      <textarea
        id="reject-why"
        className="field"
        rows={3}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="row" style={{ gap: 8 }}>
        <button type="submit" className="btn danger" disabled={p.busy}>
          {p.busy ? I.saving : I.rejectSave}
        </button>
        <button type="button" className="btn" onClick={p.onCancel}>
          {I.cancel}
        </button>
      </div>
      {err && (
        <p role="alert" style={{ margin: 0, color: "var(--magenta-text)", fontSize: 12.5 }}>
          {err}
        </p>
      )}
    </form>
  );
}

/** One item: its fields, quote, page, links and review, with Verify, Correct and Reject. */
export function ItemDetail(p: {
  item: Item;
  onReview?: (body: Record<string, unknown>, ok: string) => void;
  busy?: boolean;
  mode?: "correct" | "reject" | undefined;
  onMode?: (m: "correct" | "reject" | undefined) => void;
}) {
  const i = p.item;
  const r = i.record;
  const fields = [...Object.keys(i.fields).filter((f) => f !== "urls"), ...SHOWN].filter(
    (f) => valueText(r[f]) !== "",
  );
  const quote = quoteOf(r);
  const at = where(r);
  const review = (body: Record<string, unknown>, ok: string) => p.onReview?.(body, ok);
  return (
    <article className="stack" style={{ gap: 10 }} aria-labelledby={`item-${i.id}`}>
      <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
        <h3 id={`item-${i.id}`} className="n" style={{ fontSize: 18, margin: 0 }}>
          {i.title}
        </h3>
        <ReviewChip review={i.review} />
      </div>
      <p className="muted mono" style={{ margin: 0, fontSize: 11.5 }}>
        {kindLabel(i.kind)} · {i.id}
      </p>
      {i.review?.note && (
        <p style={{ margin: 0 }}>
          <span className="hud" style={{ fontSize: 10 }}>
            {K.review.because}:
          </span>{" "}
          {i.review.note}
        </p>
      )}
      {i.review?.corrected?.length ? (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          {K.review.correctedFields(i.review.corrected.map(fieldLabel).join(", "))}
        </p>
      ) : null}
      {i.conflict && (
        <p role="note" className="chip warn" style={{ margin: 0 }}>
          {I.conflict}
        </p>
      )}
      <dl className="run-facts" style={{ margin: 0 }}>
        {fields.map((f) => (
          <div key={f} style={{ display: "contents" }}>
            <dt>{fieldLabel(f)}</dt>
            <dd>
              {Array.isArray(r[f]) && i.fields[f] === "list" ? (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {(r[f] as unknown[]).map((x, n) => (
                    <li key={n}>{String(x)}</li>
                  ))}
                </ul>
              ) : (
                valueText(r[f])
              )}
            </dd>
          </div>
        ))}
      </dl>
      {quote && (
        <figure style={{ margin: 0 }}>
          <figcaption className="hud" style={{ fontSize: 10 }}>
            {I.quote}
          </figcaption>
          <blockquote
            style={{ margin: "4px 0", paddingLeft: 10, borderLeft: "2px solid var(--line-2)" }}
          >
            {quote}
          </blockquote>
          {at && (
            <p className="muted mono" style={{ margin: 0, fontSize: 11.5 }}>
              {at}
            </p>
          )}
        </figure>
      )}
      <div>
        <span className="hud" style={{ fontSize: 10 }}>
          {I.links}
        </span>
        {urlsOf(r).length ? (
          <Links urls={urlsOf(r)} />
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            {I.noLinks}
          </p>
        )}
      </div>
      {p.onReview && !p.mode && (
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn primary"
            disabled={p.busy}
            onClick={() => review({ verdict: "verified" }, I.verified(i.id))}
          >
            {I.verify}
          </button>
          <button
            type="button"
            className="btn"
            disabled={p.busy || Object.keys(i.fields).length === 0}
            onClick={() => p.onMode?.("correct")}
          >
            {I.correct}
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={p.busy}
            onClick={() => p.onMode?.("reject")}
          >
            {I.reject}
          </button>
        </div>
      )}
      {p.mode === "correct" && (
        <CorrectForm
          item={i}
          busy={p.busy}
          onCancel={() => p.onMode?.(undefined)}
          onSave={(set) => review({ verdict: "corrected", set }, I.corrected(i.id))}
        />
      )}
      {p.mode === "reject" && (
        <RejectForm
          busy={p.busy}
          onCancel={() => p.onMode?.(undefined)}
          onSave={(note) => review({ verdict: "rejected", note }, I.rejected(i.id))}
        />
      )}
      <span className="sr" aria-live="polite">
        {reviewText(i.review)}
      </span>
    </article>
  );
}

/** The search box and kind filter over the list. */
export function ItemFilters(p: {
  text: string;
  kind: string;
  onText: (v: string) => void;
  onKind: (v: string) => void;
}) {
  return (
    <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 10 }} role="search">
      <div className="stack" style={{ gap: 4, flex: "1 1 200px" }}>
        <label htmlFor="item-find" className="hud" style={{ fontSize: 10 }}>
          {I.search}
        </label>
        <input
          id="item-find"
          className="field"
          placeholder={I.searchHint}
          value={p.text}
          onChange={(e) => p.onText(e.target.value)}
        />
      </div>
      <div className="stack" style={{ gap: 4 }}>
        <label htmlFor="item-kind" className="hud" style={{ fontSize: 10 }}>
          {I.kind}
        </label>
        <select
          id="item-kind"
          className="field"
          value={p.kind}
          onChange={(e) => p.onKind(e.target.value)}
        >
          <option value="">{I.allKinds}</option>
          {Object.keys(K.kinds).map((k) => (
            <option key={k} value={k}>
              {kindLabel(k)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function KnowledgeItems({ hash }: { hash: string }) {
  const list = useApi<Api.KnowledgeItemListT>("/api/knowledge/items");
  const current = queryParam(hash, "item");
  const [text, setText] = useState("");
  const [kind, setKind] = useState(queryParam(hash, "kind") ?? "");
  // The form open, for the item it was opened on: picking another item closes it.
  const [open, setOpen] = useState<{ id: string; mode: "correct" | "reject" } | undefined>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | undefined>();
  useLiveEvents((e) => {
    if (e.type === "file.changed") list.reload();
  });
  const item = list.state === "ready" ? list.data.items.find((i) => i.id === current) : undefined;
  const onReview = (body: Record<string, unknown>, ok: string) => {
    if (!item) return;
    setBusy(true);
    setNote(undefined);
    api<unknown>(`/api/knowledge/items/${encodeURIComponent(item.id)}/review`, {
      method: "POST",
      body,
    })
      .then(() => {
        setNote({ ok: true, text: ok });
        setOpen(undefined);
        list.reload();
      })
      .catch((e: unknown) => setNote({ ok: false, text: message(e) }))
      .finally(() => setBusy(false));
  };
  return (
    <div className="bento">
      <Panel title={K.nav.items} span="span 5">
        <p className="work-say" style={{ marginTop: 0 }}>
          {I.intro}
        </p>
        <ItemFilters text={text} kind={kind} onText={setText} onKind={setKind} />
        <ItemList of={list} text={text} kind={kind} current={current} />
      </Panel>
      <Panel title={item?.title ?? I.open} span="span 7" labelledBy="item-detail">
        {item ? (
          <>
            <ItemDetail
              key={item.id}
              item={item}
              onReview={onReview}
              busy={busy}
              mode={open?.id === item.id ? open.mode : undefined}
              onMode={(m) => setOpen(m ? { id: item.id, mode: m } : undefined)}
            />
            <Note note={note} />
          </>
        ) : (
          <div className="state">{I.pick}</div>
        )}
      </Panel>
    </div>
  );
}
