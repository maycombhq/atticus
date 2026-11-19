/**
 * Ask: a plain-language question turned into what Atticus can answer from the catalog, a
 * query in the catalog query language or an impact walk, by fixed rules. No model is called:
 * the same question always gives the same query, and the query is shown with the answer so a
 * person can check and edit it.
 */

export type Asked =
  | {
      action: "impact";
      id: string;
      query: string;
      explanation: string;
      /**
       * Set when the question asks who receives a topic or an entry (b30 proof run): the answer
       * is the receivers, `receiversOf`, and what the walk reaches past them is said apart.
       */
      receivers?: true;
    }
  | { action: "owner"; id: string; query: string; explanation: string }
  | {
      action: "query";
      query: string;
      explanation: string;
      /**
       * Set when the question names something the map lacks and the map couldn't be read (no
       * metarepo, no catalog, a record file that doesn't read): what is wrong. The name can't
       * then be called planned or not read, and the query's empty answer means nothing.
       */
      fault?: string;
    };

/**
 * What a question's word names. `byName` is a topic found by its name, not its id: only the
 * question of who receives it reads it so (ADR 0201), and every other reading is as if the word
 * named nothing, as it was before.
 */
export type Lookup = (word: string) => { id: string; kind: string; byName?: boolean } | undefined;

/**
 * The kind a lookup gives a system only the calls name: no record is it (a model provider, a
 * vendor), but interfaces go to it. A question naming one searches its calls.
 */
export const OUTSIDE = "Outside";

/**
 * Why the map lacks an id, where the caller can tell (ADR 0201 addendum, 2026-11-19): a manifest
 * lists it and nobody read it; open changes plan it; or neither, with the ids nearest to it.
 */
export interface Lacking {
  /** A repos.manifest.yaml lists the id. */
  manifest?: boolean;
  /** The open changes that plan it. */
  plannedBy?: string[];
  /** The map's ids nearest to it, when it is neither. */
  nearest?: string[];
}

const listed = (ids: string[]) =>
  ids.length < 2 ? ids.join("") : `${ids.slice(0, -1).join(", ")} or ${ids.at(-1)!}`;

/**
 * What every command and tool says of an id the map lacks (ADR 0201): the change plans it, or
 * nobody read it yet. An answer, not a failure: a persona is told so and goes on. With `why`,
 * the same sentence first (the personas' files quote it), then which of the three it is.
 */
export function notInMap(id: string, why?: Lacking): string {
  const said = `${id} is not in the map: planned or not read.`;
  if (!why) return said;
  const parts: string[] = [];
  if (why.manifest)
    parts.push(`${id} is in the manifests and hasn't been read (atticus map ${id}).`);
  if (why.plannedBy?.length)
    parts.push(
      `${id} is planned by change${why.plannedBy.length === 1 ? "" : "s"} ${why.plannedBy.join(", ")}.`,
    );
  if (!parts.length)
    parts.push(
      `Neither: no manifest lists ${id} and no open change plans it${why.nearest?.length ? `. Did you mean ${listed(why.nearest)}?` : "."}`,
    );
  return [said, ...parts].join(" ");
}

/** Says which of the three a missing id is (`notInMap` with its `Lacking`); the caller's. */
export type Lacks = (id: string) => string;

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
 * else a table by its name; else a topic by its name, marked `byName` (a real metarepo, 2026-10-25: "what calls the LLM?" listed every
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
    try {
      const t = ix.query(`kind:table name:${w}`, { limit: 1 }).rows[0];
      if (t) return { id: t.id, kind: t.kind };
      // A topic by its name (`transfers.completed` is the Endpoint `topic.transfers-completed`).
      const e = ix.query(`kind:endpoint endpointType:event-topic pathOrTopic:${w}`, { limit: 1 })
        .rows[0];
      if (e) return { id: e.id, kind: e.kind, byName: true };
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

/** A topic's other end is whoever receives it: the verbs that ask for them. */
const RECEIVES =
  /\b(who|what|which)\b.*\b(consumes?|subscribes?|subscribed|receives?|listens?|listening)\b/;
/** Who puts events on a topic: the verbs that ask for them. */
const PUBLISHES = /\b(who|what|which)\b.*\b(publish(es|ed)?|produces?|emits?|sends?)\b/;
/** After "calls", these make it a noun ("what calls are inferred"), not a verb with a name after. */
const NOT_A_NAME = new Set(
  "are is were have has go goes going through via from without with in at".split(" "),
);
/** Words that say what kind of thing the name is, never the name. */
const NOUNS = new Set("service component system repo app job".split(" "));

/**
 * The one name "who calls X" asks about when no record is X (ADR 0201): the single plain word
 * left after "calls". Undefined when the words after it aren't one name.
 */
function calledName(words: string[]): string | undefined {
  const at = words.findIndex((w) => w === "calls" || w === "call");
  if (at < 1 || !/^(who|what|which)$/.test(words[0]!)) return undefined;
  const after = words.slice(at + 1);
  if (!after.length || NOT_A_NAME.has(after[0]!)) return undefined;
  const rest = after.filter((w) => !STOP.has(w) && !NOUNS.has(w));
  return rest.length === 1 && PLAIN.test(rest[0]!) && !KIND_WORDS[rest[0]!] ? rest[0] : undefined;
}

/**
 * A name shaped like an id or a topic's name: a dot, a dash or an underscore in it
 * (`forge-portal`, `forge.orders.shipped`). Only such a name is said to be missing where a plain
 * word ("who sends notifications?", "what does billing use") stays a word search, as it was (the
 * review of b30/proof-fixes).
 */
const ID_SHAPED = /[._-]/;

/** Words that say a name is a topic's, never the name. */
const TOPIC_NOUNS = new Set("topic topics event events queue message messages".split(" "));

/**
 * The one name a question asks about after its verb, when no record is it (b30 proof run: "who
 * publishes X", "who consumes the topic X"): the single plain word left. Undefined otherwise.
 */
function nameAfter(words: string[], verb: RegExp): string | undefined {
  const at = words.findIndex((w) => verb.test(w));
  if (at < 1 || !/^(who|what|which)$/.test(words[0]!)) return undefined;
  const rest = words
    .slice(at + 1)
    .filter((w) => !STOP.has(w) && !NOUNS.has(w) && !TOPIC_NOUNS.has(w));
  return rest.length === 1 &&
    PLAIN.test(rest[0]!) &&
    ID_SHAPED.test(rest[0]!) &&
    !KIND_WORDS[rest[0]!]
    ? rest[0]
    : undefined;
}

/** The one name in "what does X call" when no record is X, shaped like an id. */
function callerName(words: string[]): string | undefined {
  const from = words.indexOf("does");
  const to = words.findIndex((w, n) => n > from && /^(calls?|uses?|depends?|talks?)$/.test(w));
  if (words[0] !== "what" || from !== 1 || to < 0) return undefined;
  const rest = words.slice(from + 1, to).filter((w) => !STOP.has(w) && !NOUNS.has(w));
  return rest.length === 1 &&
    PLAIN.test(rest[0]!) &&
    ID_SHAPED.test(rest[0]!) &&
    !KIND_WORDS[rest[0]!]
    ? rest[0]
    : undefined;
}

/** The first word of the question that names a catalog record, longest first. */
function named(words: string[], lookup: Lookup) {
  for (const w of [...words].sort((a, b) => b.length - a.length)) {
    const hit = lookup(w);
    if (hit) return hit;
  }
  return undefined;
}

export function translate(
  question: string,
  lookup: Lookup,
  /** Why the map can't say what it lacks (`mapFault`), asked only when a name is missing. */
  fault?: () => string | undefined,
  /** What is said of a name the map lacks; `notInMap` when the caller can't tell which. */
  lacks: Lacks = notInMap,
): Asked {
  const q = question.trim();
  const lower = q.toLowerCase();
  const words = lower
    .replace(/[?!,;"'`()]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/\.$/, ""))
    .filter(Boolean);
  // A topic found by its name answers only who receives it: every older reading sees the records
  // it always saw, and never that name in their place.
  const rec = named(words, (w) => {
    const hit = lookup(w);
    return hit?.byName ? undefined : hit;
  });
  const topic = () => rec ?? named(words, lookup);
  const has = (re: RegExp) => re.test(lower);
  const receivers = (id: string): Asked => ({
    action: "impact",
    id,
    query: `impact ${id}`,
    explanation: `Read as: who receives ${id}: the receivers first, then what a change reaches past them.`,
    receivers: true,
  });
  // The calls and events on an entry or a topic are the Interfaces that name it as `endpoint`.
  const onEndpoint = (id: string, publish: boolean): Asked => ({
    action: "query",
    query: `kind:interface endpoint:${id}`,
    explanation: publish
      ? `Read as: the interfaces that publish to ${id}; each one's "from" is the publisher.`
      : `Read as: the interfaces that call ${id}; each one's "from" is the caller.`,
  });
  // A name the map lacks: said so, with the query that would have answered (ADR 0201).
  const missing = (name: string, query: string, read: string): Asked => {
    // "Not in the map" only of a map that was read whole (ADR 0201 amendment).
    const why = fault?.();
    return {
      action: "query",
      query,
      explanation: `Read as: ${read}. ${why ?? lacks(name)}`,
      ...(why ? { fault: why } : {}),
    };
  };

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
  if (rec && has(/\b(who|what|which)\b.*\b(calls?|uses?|consumes?|reads?|writes?)\b/)) {
    // A topic's consumers aren't an Interface's `to`: an event Interface names the topic under
    // `endpoint`, and its `to` is the subscriber. The impact walk follows that (ADR 0201).
    if (rec.kind === "Endpoint" && has(/\bconsumes?\b/)) return receivers(rec.id);
    // Who calls an entry: an Interface's `to` is the component, and the entry is its `endpoint`.
    if (rec.kind === "Endpoint" && has(/\b(calls?|uses?)\b/)) return onEndpoint(rec.id, false);
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
  // "What does X call" where nothing is X was a word search for "X call" (b30 proof run).
  const caller =
    !rec && !topic() && has(/\bwhat does\b.*\b(call|use|depend|talk)/) ? callerName(words) : "";
  if (caller)
    return missing(caller, `kind:interface from:${caller}`, `the interfaces ${caller} calls`);
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
    // "Who calls X" where nothing is X read as every interface. X is said to be missing (ADR 0201).
    const called =
      terms.length === 1 && terms[0] === "kind:interface" && !topic()
        ? calledName(words)
        : undefined;
    if (called)
      return missing(
        called,
        `kind:interface to:${called}`,
        `the interfaces whose callee is ${called}`,
      );
    return {
      action: "query",
      query: terms.join(" "),
      explanation: `Read as: ${KIND_WORDS[kindWord]} records${terms.length > 1 ? " where " + terms.slice(1).join(", ") : ""}.`,
    };
  }

  // No older reading matched: who subscribes to, receives or listens to a topic the map holds.
  const end = has(RECEIVES) ? topic() : undefined;
  if (end?.kind === "Endpoint") return receivers(end.id);
  // Who publishes to a topic the map holds, by its id or its name (b30 proof run).
  const published = has(PUBLISHES) ? topic() : undefined;
  if (published?.kind === "Endpoint") return onEndpoint(published.id, true);
  // The same two questions about a name the map lacks were a word search that found nothing.
  if (!rec && !topic()) {
    const received = has(RECEIVES)
      ? nameAfter(words, /^(consumes?|subscribes?|subscribed|receives?|listens?|listening)$/)
      : undefined;
    if (received)
      return missing(received, `kind:endpoint pathOrTopic:${received}`, `who receives ${received}`);
    const sent = has(PUBLISHES)
      ? nameAfter(words, /^(publish(es|ed)?|produces?|emits?|sends?)$/)
      : undefined;
    if (sent) return missing(sent, `kind:endpoint pathOrTopic:${sent}`, `who publishes to ${sent}`);
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
