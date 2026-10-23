import type { Api } from "@maycombhq/core";
import { ExternalLink } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { Command } from "../work/RunNext.js";
import "../run/run.css";
import "../work/work.css";

/**
 * Pieces the knowledge screens share (ADR 0102): a review's words, the AI step to copy, the
 * links an item gives, and pure helpers the tests check (search, grouping, the correction).
 */

const K = COPY.knowledge;

export type Item = Api.KnowledgeItemViewT;
export type Review = Api.KnowledgeReviewSummaryT;
export type Link = { url: string; label?: string };
export type FieldType = "text" | "list" | "links";

export const kindLabel = (k: string) => K.kinds[k] ?? k;
export const fieldLabel = (f: string) => K.fields[f] ?? f;
const day = (at: string) => at.slice(0, 10);

/** A review in words: the tick for verified or corrected, check again, rejected, or none. */
export function reviewText(r: Review | undefined): string {
  if (!r) return K.review.none;
  if (r.state === "verified") return K.review.verified(r.by, day(r.at));
  if (r.state === "corrected") return K.review.corrected(r.by, day(r.at));
  if (r.state === "rejected") return K.review.rejected(r.by, day(r.at));
  return K.review.stale(r.by);
}

const CHIP: Record<string, string> = {
  verified: "done",
  corrected: "done",
  rejected: "blocking",
  stale: "warn",
};

/** The review as a chip; the words always carry it, never the colour alone. */
export function ReviewChip({ review }: { review: Review | undefined }) {
  return (
    <span className={`chip ${review ? CHIP[review.state] : "dim"}`}>{reviewText(review)}</span>
  );
}

/** An AI step the app doesn't run: the command and the slash command, each with Copy. */
export function AiStep({ command, slash, why }: { command: string; slash?: string; why?: string }) {
  return (
    <div className="stack" style={{ gap: 4 }}>
      {why && <p className="work-why">{why}</p>}
      <p className="work-say">{K.ai.intro}</p>
      <Command text={command} label={K.ai.copy} />
      {slash && (
        <>
          <p className="work-say">{K.ai.slash}</p>
          <Command text={slash} label={K.ai.copySlash} />
        </>
      )}
    </div>
  );
}

/**
 * Nothing read from the wikis yet: what to do, with the Knowledge sources page one click away
 * and the knowledge scan to copy (an AI step the app doesn't run).
 */
export function NoKnowledgeYet({ text }: { text: string }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="state">{text}</div>
      <p style={{ margin: 0 }}>
        <a href="#/wikis">{K.emptyGo}</a>
      </p>
      <AiStep command="atticus knowledge scan" slash="/atticus-knowledge" />
    </div>
  );
}

/** The links a page gives for an item; each opens in a new tab and says where it goes. */
export function Links({ urls }: { urls: Link[] }) {
  if (!urls.length) return null;
  return (
    <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
      {urls.map((u) => (
        <li key={u.url}>
          <ExternalLink href={u.url}>{u.label ?? u.url}</ExternalLink>
          {u.label && (
            <span className="muted mono" style={{ fontSize: 11, marginLeft: 6 }}>
              {u.url}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Where the item was read: source/page, under its heading, at its line. */
export function where(record: Record<string, unknown>): string | undefined {
  const q = record.quote as
    { source: string; page: string; section: string; line?: number } | undefined;
  if (!q) return undefined;
  return K.items.page(`${q.source}/${q.page}${q.section ? ` (${q.section})` : ""}`, q.line);
}

export const quoteOf = (record: Record<string, unknown>) =>
  (record.quote as { text?: string } | undefined)?.text;

export const urlsOf = (record: Record<string, unknown>): Link[] =>
  Array.isArray(record.urls) ? (record.urls as Link[]) : [];

/** A field's value as text, for a list a comma-separated line. */
export function valueText(v: unknown): string {
  if (Array.isArray(v))
    return v
      .map((x) => (typeof x === "object" && x ? ((x as Link).label ?? (x as Link).url) : String(x)))
      .join(", ");
  return v === undefined || v === null ? "" : String(v);
}

/** Items whose title, id, kind, handler or quote has every word of the text. */
export function matchItem(i: Item, text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const r = i.record;
  const hay = [
    i.id,
    i.title,
    i.kind,
    valueText(r.handledBy),
    valueText(r.owner),
    valueText(r.ownedBy),
    valueText(r.aliases),
    valueText(r.appliesWhen),
    quoteOf(r) ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Items grouped as the copy file's groups are, in order; empty groups are left out. */
export function groupItems<T extends { kind: string }>(
  items: T[],
  groups: readonly { title: string; kinds: readonly string[] }[],
): { title: string; items: T[] }[] {
  return groups
    .map((g) => ({ title: g.title, items: items.filter((i) => g.kinds.includes(i.kind)) }))
    .filter((g) => g.items.length > 0);
}

/** A correction form's values: text, a list of strings, or links. */
export type FormValue = string | string[] | Link[];

/** The form's starting values: what the item says now, correction included. */
export function formOf(item: Item): Record<string, FormValue> {
  const out: Record<string, FormValue> = {};
  for (const [f, t] of Object.entries(item.fields)) {
    const v = item.record[f];
    if (t === "text") out[f] = typeof v === "string" ? v : "";
    else if (t === "list") out[f] = Array.isArray(v) ? (v as unknown[]).map(String) : [];
    else
      out[f] = urlsOf(item.record).map((u) => ({
        url: u.url,
        ...(u.label ? { label: u.label } : {}),
      }));
  }
  return out;
}

const same = (a: FormValue, b: FormValue) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What a correction sends: only the fields the person changed, lists without empty entries,
 * links without empty rows. An error when a link isn't an http(s) address, or nothing changed
 * on an item no one has corrected yet.
 */
export function correctionBody(
  item: Item,
  form: Record<string, FormValue>,
): { set: Record<string, FormValue> } | { error: string } {
  const start = formOf(item);
  const set: Record<string, FormValue> = {};
  for (const [f, t] of Object.entries(item.fields)) {
    let v = form[f] ?? start[f]!;
    if (t === "text") v = (v as string).trim();
    else if (t === "list") v = (v as string[]).map((x) => x.trim()).filter(Boolean);
    else {
      const links: Link[] = [];
      for (const l of v as Link[]) {
        const url = l.url.trim();
        const label = l.label?.trim();
        if (!url && !label) continue;
        if (!/^https?:\/\/\S+$/.test(url)) return { error: K.items.badUrl(url || label || "") };
        links.push(label ? { url, label } : { url });
      }
      v = links;
    }
    if (!same(v, start[f]!)) set[f] = v;
  }
  if (!Object.keys(set).length && !item.review?.corrected?.length)
    return { error: K.items.noChange };
  return { set };
}

/** Comma-separated tags as a list; an error names one that isn't a lowercase slug. */
export function tagsOf(text: string): string[] | { error: string } {
  const tags = text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const bad = tags.find((t) => !/^[a-z0-9][a-z0-9._-]*$/.test(t));
  return bad ? { error: K.sources.notSlug(bad) } : tags;
}
