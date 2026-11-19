/**
 * Ask: a plain-language question turned into what Atticus can answer from the catalog, a
 * query in the catalog query language or an impact walk, by fixed rules. No model is called:
 * the same question always gives the same query, and the query is shown with the answer so a
 * person can check and edit it.
 */

export type Asked =
  | { action: "impact"; id: string; query: string; explanation: string }
  | { action: "owner"; id: string; query: string; explanation: string }
  | { action: "query"; query: string; explanation: string };

export type Lookup = (word: string) => { id: string; kind: string } | undefined;

/**
 * The kind a lookup gives a system only the calls name: no record is it (a model provider, a
 * vendor), but interfaces go to it. A question naming one searches its calls.
 */
export const OUTSIDE = "Outside";

/**
 * What every command and tool says of an id the map lacks (ADR 0201): the change plans it, or
 * nobody read it yet. An answer, not a failure: a persona is told so and goes on.
 */
export function notInMap(id: string): string {
  return `${id} is not in the map: planned or not read.`;
}

/** What `askLookup` needs of the index. */
export interface AskIndex {
  find(id: string): { id: string; kind: string }[];
  query(text: string, o?: { limit?: number }): { rows: { id: string; kind: string }[] };
}

/** A word plain enough to put in a query as a value: no quote, comma, colon or space. */
const PLAIN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Look a question's word up in the catalog, the way `atticus ask` and the app's Ask both do: a
 * record by its id; else an outside system the interfaces call (or are called from) by that name;
 * else a topic or path by its name (`transfers.completed` is the Endpoint
 * `topic.transfers-completed`); else a table by its name (a real metarepo, 2026-10-25: "what calls the LLM?" listed every
 * interface, because nothing named `llm` was a record).
 */
export function askLookup(ix: AskIndex): Lookup {
  return (word) => {
    const w = word.toLowerCase();
    const rec = ix.find(w)[0];
    if (rec) return { id: rec.id, kind: rec.kind };
    if (!PLAIN.test(w) || STOP.has(w) || KIND_WORDS[w]) return undefined;
    const has = (q: string) => {
      try {
        return ix.query(q, { limit: 1 }).rows.length > 0;
      } catch {
        return false;
      }
    };
    if (has(`kind:interface to:${w}`) || has(`kind:interface from:${w}`))
      return { id: w, kind: OUTSIDE };
    for (const q of [`kind:endpoint pathOrTopic:${w}`, `kind:table name:${w}`])
      try {
        const t = ix.query(q, { limit: 1 }).rows[0];
        if (t) return { id: t.id, kind: t.kind };
      } catch {
        // not a value the query language takes
      }
    return undefined;
  };
}

const KIND_WORDS: Record<string, string> = {
  interfaces: "interface",
  interface: "interface",
  calls: "interface",
  tables: "table",
  table: "table",
  endpoints: "endpoint",
  apis: "endpoint",
  components: "component",
  services: "component",
  systems: "system",
  settings: "setting",
  columns: "column",
  topics: "topic",
  features: "capability",
  migrations: "migration",
  deployments: "deployment",
};

const STOP = new Set(
  "a an the of in on to for by is are was what which who whom how does do did if when me show list find all any with that this there it its and or please".split(
    " ",
  ),
);

/** Who is at the other end of a record: the verbs of "who calls X". */
const USES = "calls?|uses?|consumes?|reads?|writes?";
/** The same for a topic, whose other end is whoever receives it. */
const RECEIVES = "consumes?|subscribes?|subscribed|receives?|listens?|listening";
/** After "calls", these make it a noun ("what calls are inferred"), not a verb with a name after. */
const NOT_A_NAME = new Set(
  "are is were have has go goes going through via from without with in at inferred unconfirmed".split(
    " ",
  ),
);
/** Words that say what kind of thing the name is, never the name. */
const NOUNS = new Set(
  "topic queue event service component system endpoint api repo table".split(" "),
);

/**
 * The name a "who calls X" question asks about when no record is X: the one word left after the
 * verb. Undefined when the words after the verb aren't one plain name.
 */
function askedAbout(words: string[]): string | undefined {
  const verb = new RegExp(`^(${USES}|${RECEIVES})$`);
  const at = words.findIndex((w) => verb.test(w));
  if (at < 1 || !/^(who|what|which)$/.test(words[0]!)) return undefined;
  const after = words.slice(at + 1);
  if (!after.length || NOT_A_NAME.has(after[0]!)) return undefined;
  const rest = after.filter((w) => !STOP.has(w) && !NOUNS.has(w));
  return rest.length === 1 && PLAIN.test(rest[0]!) && !KIND_WORDS[rest[0]!] ? rest[0] : undefined;
}

/** The first word of the question that names a catalog record, longest first. */
function named(words: string[], lookup: Lookup) {
  for (const w of [...words].sort((a, b) => b.length - a.length)) {
    const hit = lookup(w);
    if (hit) return hit;
  }
  return undefined;
}

export function translate(question: string, lookup: Lookup): Asked {
  const q = question.trim();
  const lower = q.toLowerCase();
  const words = lower
    .replace(/[?!,;"'`()]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/\.$/, ""))
    .filter(Boolean);
  const rec = named(words, lookup);
  const has = (re: RegExp) => re.test(lower);

  // A system only the calls name has no record to walk or own: what reaches it are its callers.
  if (rec?.kind === OUTSIDE)
    return {
      action: "query",
      query: `kind:interface to:${rec.id}`,
      explanation: `Read as: the calls to ${rec.id}, a system outside the estate that the code calls.`,
    };
  if (has(/\b(break|breaks|affected|impacted|impact|reach|reaches|depends? on)\b/)) {
    if (rec)
      return {
        action: "impact",
        id: rec.id,
        query: `impact ${rec.id}`,
        explanation: `Read as: what a change to ${rec.id} reaches, hop by hop, with owners.`,
      };
  }
  if (rec && has(/\bwhat does\b.*\b(call|use|depend|talk)/))
    return {
      action: "query",
      query: `kind:interface from:${rec.id}`,
      explanation: `Read as: the interfaces ${rec.id} calls.`,
    };
  // A topic's consumers aren't an Interface's `to` by its name: an event Interface names the topic
  // under `endpoint`, and its `to` is the subscriber. The impact walk follows that (ADR 0201).
  if (rec?.kind === "Endpoint" && has(new RegExp(`\\b(who|what|which)\\b.*\\b(${RECEIVES})\\b`)))
    return {
      action: "impact",
      id: rec.id,
      query: `impact ${rec.id}`,
      explanation: `Read as: who receives ${rec.id}, from what a change to it reaches.`,
    };
  // A name the map lacks is said, never answered with every interface (the kind word "calls").
  const unknown = rec ? undefined : askedAbout(words);
  if (unknown)
    return {
      action: "query",
      query: `kind:interface to:${unknown}`,
      explanation: `Read as: the interfaces whose callee is ${unknown}. ${notInMap(unknown)}`,
    };
  if (rec && has(new RegExp(`\\b(who|what|which)\\b.*\\b(${USES})\\b`))) {
    if (rec.kind === "Table" || rec.kind === "Column")
      return {
        action: "query",
        query: `refby:${rec.id} kind:component`,
        explanation: `Read as: the components that read or write ${rec.id}.`,
      };
    return {
      action: "query",
      query: `kind:interface to:${rec.id}`,
      explanation: `Read as: the interfaces whose callee is ${rec.id}.`,
    };
  }
  if (rec && has(/\bwho owns\b|\bowner of\b/))
    return {
      action: "owner",
      id: rec.id,
      query: rec.id,
      explanation: `Read as: the owner recorded for ${rec.id}.`,
    };

  const terms: string[] = [];
  const system = rec?.kind === "System" ? rec.id : undefined;
  if (has(/\b(personal|sensitive|pii|confidential)\b/)) {
    terms.push("kind:column");
    if (system) terms.push(`system:${system}`);
    terms.push("classification:personal*");
    return {
      action: "query",
      query: terms.join(" "),
      explanation: `Read as: columns tagged as personal data${system ? ` in ${system}` : ""}. Untagged columns don't show.`,
    };
  }
  const kindWord = words.find((w) => KIND_WORDS[w]);
  if (kindWord) {
    terms.push(`kind:${KIND_WORDS[kindWord]}`);
    if (has(/\bgateway\b/)) terms.push("via:gateway");
    else if (has(/\b(event bus|event-bus|events?)\b/)) terms.push("via:event-bus");
    if (system) terms.push(`system:${system}`);
    else if (rec) terms.push(`refs:${rec.id}`);
    if (has(/\b(without|no|missing) (a |an )?pattern\b/)) terms.push("missing:pattern");
    if (has(/\b(inferred|unconfirmed|one end)\b/)) {
      terms.push("confidence:inferred");
      // A link a person paired cites both ends: not one seen at one end (ADR 0174).
      if (has(/\bone end\b/)) terms.push("-flags:joined-by-person");
    }
    return {
      action: "query",
      query: terms.join(" "),
      explanation: `Read as: ${KIND_WORDS[kindWord]} records${terms.length > 1 ? " where " + terms.slice(1).join(", ") : ""}.`,
    };
  }

  const text = words.filter((w) => !STOP.has(w));
  const query = rec ? rec.id : text.join(" ");
  return {
    action: "query",
    query: query || q,
    explanation: rec
      ? `Read as: a search for ${rec.id}.`
      : `No record in the catalog is named in the question, so this is a word search for "${text.join(" ")}".`,
  };
}
