import type { Api } from "@maycombhq/core";
import { useApi, useLiveEvents, type Loaded } from "../../api/client.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { kindLabel, Links, NoKnowledgeYet, ReviewChip, urlsOf, type Item } from "./shared.js";

/**
 * Teams, vendors and products (ADR 0102): the Party and Product knowledge items, browsable.
 * For a team, what it owns and uses, by its own page and by the products that name it; for a
 * product, who owns and uses it and its vendor; for each, the other names people use.
 */

const K = COPY.knowledge;
const P = K.parties;

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const norm = (s: string) => s.trim().toLowerCase();

/** The names an item goes by: its id, name and aliases, folded. */
const namesOf = (i: Item) => new Set([i.id, i.title, ...strs(i.record.aliases)].map(norm));

export interface PartyView {
  item: Item;
  aliases: string[];
  responsibilities: string[];
  owns: string[];
  uses: string[];
  ownedBy?: string;
  usedBy: string[];
  vendor?: string;
}

/**
 * Each team, vendor and product with what it owns and uses: from its own page, and from the
 * products whose owner, users or vendor name it (by name, id or alias).
 */
export function relations(items: Item[]): {
  teams: PartyView[];
  vendors: PartyView[];
  products: PartyView[];
} {
  const products = items.filter((i) => i.kind === "product" || i.kind === "project");
  const view = (i: Item): PartyView => {
    const names = namesOf(i);
    const named = (v: unknown) => !!str(v) && names.has(norm(str(v)!));
    const merge = (a: string[], b: string[]) => {
      const seen = new Set(a.map(norm));
      return [...a, ...b.filter((x) => !seen.has(norm(x)) && seen.add(norm(x)))];
    };
    const r = i.record;
    const party = i.kind === "team" || i.kind === "vendor";
    return {
      item: i,
      aliases: strs(r.aliases),
      responsibilities: strs(r.responsibilities),
      owns: party
        ? merge(
            strs(r.owns),
            products
              .filter(
                (p) => named(p.record.ownedBy) || (i.kind === "vendor" && named(p.record.vendor)),
              )
              .map((p) => p.title),
          )
        : [],
      uses: party
        ? merge(
            strs(r.uses),
            products.filter((p) => strs(p.record.usedBy).some((u) => named(u))).map((p) => p.title),
          )
        : [],
      ...(str(r.ownedBy) ? { ownedBy: str(r.ownedBy)! } : {}),
      usedBy: strs(r.usedBy),
      ...(str(r.vendor) ? { vendor: str(r.vendor)! } : {}),
    };
  };
  const by = (k: string[]) =>
    items
      .filter((i) => k.includes(i.kind))
      .map(view)
      .sort((a, b) => a.item.title.localeCompare(b.item.title));
  return { teams: by(["team"]), vendors: by(["vendor"]), products: by(["product", "project"]) };
}

function Names({ label, names }: { label: string; names: string[] }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{names.length ? names.join(", ") : <span className="muted">{P.none}</span>}</dd>
    </>
  );
}

function Card({ v }: { v: PartyView }) {
  const i = v.item;
  const product = i.kind === "product" || i.kind === "project";
  return (
    <li className="list-row" style={{ display: "block" }}>
      <div className="row between" style={{ flexWrap: "wrap", gap: 6 }}>
        <span>
          <a href={`#/knowledge?item=${encodeURIComponent(i.id)}`} title={P.review}>
            <strong>{i.title}</strong>
          </a>{" "}
          <span className="muted mono" style={{ fontSize: 11 }}>
            {kindLabel(i.kind)} · {i.id}
          </span>
        </span>
        <ReviewChip review={i.review} />
      </div>
      <dl className="run-facts" style={{ margin: "6px 0 0" }}>
        {v.aliases.length > 0 && <Names label={P.aliases} names={v.aliases} />}
        {v.responsibilities.length > 0 && (
          <Names label={P.responsibilities} names={v.responsibilities} />
        )}
        {product ? (
          <>
            <Names label={P.ownedBy} names={v.ownedBy ? [v.ownedBy] : []} />
            <Names label={P.usedBy} names={v.usedBy} />
            {v.vendor && <Names label={K.fields.vendor!} names={[v.vendor]} />}
          </>
        ) : (
          <>
            <Names label={P.owns} names={v.owns} />
            <Names label={P.uses} names={v.uses} />
          </>
        )}
      </dl>
      <Links urls={urlsOf(i.record)} />
    </li>
  );
}

function Group({ title, list }: { title: string; list: PartyView[] }) {
  return (
    <Panel title={`${title} (${list.length})`} span="span 4">
      {list.length === 0 ? (
        <div className="state">{P.none}</div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {list.map((v) => (
            <Card key={v.item.id} v={v} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function PartiesPage({ of }: { of: Loaded<Api.KnowledgeItemListT> }) {
  return (
    <View
      of={of}
      empty={(d) => !d.items.some((i) => ["team", "vendor", "product", "project"].includes(i.kind))}
      emptyContent={
        <Panel title={K.nav.parties}>
          <NoKnowledgeYet text={P.empty} />
        </Panel>
      }
    >
      {(d) => {
        const r = relations(d.items.filter((i) => i.review?.state !== "rejected"));
        return (
          <div className="bento">
            <Group title={P.teams} list={r.teams} />
            <Group title={P.vendors} list={r.vendors} />
            <Group title={P.products} list={r.products} />
          </div>
        );
      }}
    </View>
  );
}

export function Parties() {
  const list = useApi<Api.KnowledgeItemListT>("/api/knowledge/items");
  useLiveEvents((e) => {
    if (e.type === "file.changed") list.reload();
  });
  return (
    <>
      <p className="work-say" style={{ marginTop: 0 }}>
        {P.intro}
      </p>
      <PartiesPage of={list} />
    </>
  );
}
