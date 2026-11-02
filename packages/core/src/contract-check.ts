import { z } from "zod";
import { factIdPart } from "./facts.js";
import { isHeaderName, typeFamily } from "./facts-join-prototype.js";
import type { FactEnd, FactJoin, FactsJoinResult } from "./facts-join.js";
import type { VendorCallMatch } from "./facts-join-vendor.js";
import { normalizePath } from "./identity.js";
import type { Fact, FactOf } from "./schema/facts.js";

/**
 * The contract check on every link (plan item F7, ADR 0164). For every REST call the estate join
 * ties to an entry, every publish joined to its listeners, every hop through a gateway and every
 * call left to an outside system whose spec is on file, the payload on both sides is compared:
 * from the field facts the reader wrote (each cited), and from the specs on file — a repo's own
 * published spec (a gateway's OpenAPI in its proxy repo's spec folder), a consumer's copy of the
 * API it calls (J3), a topic's message spec (a `.proto` message, an Avro record, a JSON Schema or
 * an AsyncAPI message, in the repo, in a shared schema repo of the estate, or another team's or a
 * vendor's taken in through intake, O2).
 *
 * What is compared: a field sent that the other side doesn't take, one read that it never
 * returns, one required on one side and not sent, a type of another family, an error status
 * one side answers and the other doesn't list, and (protobuf) a field number given to another
 * name or type. A side whose facts say nothing about a payload is unknown, never different
 * (ADR 0125's rule).
 *
 * Wrapping is read from the code, never assumed: an envelope (a `Response<T>` whose `data` holds
 * the payload) is a field fact `mappedTo` the envelope's field with a `transform` that says so;
 * a mapper (MapStruct, a converter) is a field `mappedTo` the field it becomes, on the same
 * owner and side; a gateway policy that reshapes a payload (Apigee AssignMessage, JavaScript,
 * XSL) is a field of the route `mappedTo` one of its forwarding call, or the other way, each
 * cited on the policy's line. A field with a `transform` and no traced `mappedTo` is a mapping
 * nobody traced: a difference that touches it is `unconfirmed`, never a mismatch.
 *
 * Pure and deterministic: the same facts, join and specs give the same findings, in the same
 * order, whatever order they come in. Nothing is organisation-specific.
 */

type Field = FactOf<"field">;
type Call = FactOf<"call">;
type Entry = FactOf<"entry">;

// ------------------------------------------------------------------ the specs on file

/** A field a spec lists: a request or response property or parameter, or a message's field. */
export const SpecField = z.strictObject({
  side: z.enum(["request", "response", "message"]),
  /** Dotted for a nested property, `[]` for an array's items: `data.items[].id`. */
  name: z.string().min(1),
  type: z.string().optional(),
  /** true: it must be present; false: it may be left out; left out: the spec doesn't say. */
  required: z.boolean().optional(),
  /** Where a request field travels: body, query, header, cookie, form. */
  in: z.string().optional(),
  /** A protobuf field's number, or an Avro field's position (never compared for Avro). */
  number: z.number().int().nonnegative().optional(),
  /** spec path:line of the property. */
  at: z.string().min(1),
});
export type SpecFieldT = z.infer<typeof SpecField>;

export const SPEC_FORMATS = ["openapi", "protobuf", "avro", "json-schema", "asyncapi"] as const;

/**
 * One operation or one message a spec file describes, as the contract check reads it. An
 * operation has a method and a path (with the server's path in front); a message has the name
 * of its type (a proto message's full name, an Avro record's, a JSON Schema's title) and, when
 * the spec says (AsyncAPI), the topic it travels on.
 */
export const ContractSpec = z.strictObject({
  kind: z.enum(["operation", "message"]),
  format: z.enum(SPEC_FORMATS),
  /**
   * `own`: the repo serves it (its entries do: a gateway's published spec); `consumer`: the repo
   * calls it (J3, a consumer's copy); `schema`: a message spec, whoever holds it.
   */
  role: z.enum(["own", "consumer", "schema"]),
  /** The file, relative to its repo (or the metarepo, for one taken in through intake). */
  file: z.string().min(1),
  line: z.number().int().positive(),
  method: z.string().optional(),
  path: z.string().optional(),
  /** The entry fact of the repo it describes, for an `own` operation. */
  entry: z.string().optional(),
  /** A message's type, fully qualified when the spec gives a package or namespace. */
  name: z.string().optional(),
  topic: z.string().optional(),
  /** An operation's catalog Endpoint id, for a vendor's (ADR 0130). */
  id: z.string().optional(),
  fields: z.array(SpecField),
  /** The error statuses (4xx, 5xx) an operation lists, each with its line. */
  errors: z.array(z.strictObject({ status: z.string(), at: z.string() })).optional(),
});
export type ContractSpecT = z.infer<typeof ContractSpec>;

/**
 * The facts companion `<repo>.specs.yaml` (ADR 0164): the specs a repo's checkout holds, read at
 * the facts' commit by `atticus verify <repo> --write`, so the contract check reads the same
 * specs on every run without the checkout.
 */
export const SpecsFile = z.strictObject({
  schemaVersion: z.literal(1),
  repo: z.string().min(1),
  commit: z.string().optional(),
  specs: z.array(ContractSpec),
});
export type SpecsFileT = z.infer<typeof SpecsFile>;

/** The specs of a system outside the estate, taken in through intake (O2). */
export interface OutsideSpecs {
  system: string;
  name: string;
  specs: readonly ContractSpecT[];
}

// ------------------------------------------------------------------ findings

export const CONTRACT_KINDS = [
  "field-missing",
  "field-extra",
  "field-not-sent",
  "field-required",
  "field-type",
  "field-number",
  "error-unlisted",
  "error-unanswered",
] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];

/** One end of a comparison: who says it (a repo's code, a spec), the value, and its line. */
export interface ContractEnd {
  /** The repo whose code or spec it is, or the outside system. */
  repo?: string;
  system?: string;
  /** What this end is, in words: `forge-portal-bff's call`, `the spec forge-accounts-v1.yaml`. */
  what: string;
  value?: string;
  /** path:line. */
  at?: string;
}

export interface ContractMismatch {
  /** Stable: the link, the boundary, the kind, the side and the field or status. */
  id: string;
  /** The catalog Interface of the link, when the join gives one. */
  interface?: string;
  /** Every Interface it concerns: the link's, and each gateway hop's forwarding call's. */
  interfaces?: string[];
  /** The call the link starts at (the publish, for a topic). */
  call: FactEnd;
  /** What it reaches: an entry of the estate, or an outside system. */
  entry?: FactEnd;
  system?: string;
  /** `mismatch`: the two sides disagree; `unconfirmed`: a mapping on the way isn't traced. */
  status: "mismatch" | "unconfirmed";
  kind: ContractKind;
  side?: "request" | "response" | "message";
  field?: string;
  error?: string;
  /** The side that sends (or, for a response, reads) and the side that takes (or returns). */
  sender: ContractEnd;
  receiver: ContractEnd;
  /** The mapping lines the comparison went through (`repo path:line`), in order. */
  via?: string[];
  /** The mapping that isn't traced, when `unconfirmed`. */
  untraced?: string;
  message: string;
}

/** A link compared: how many boundaries had something on both sides, and what was found. */
export interface ContractLink {
  key: string;
  interface?: string;
  /** Every Interface the link's check concerns: its own, and each gateway hop's forwarding call's. */
  interfaces?: string[];
  call: FactEnd;
  entry?: FactEnd;
  system?: string;
  kind: "rest" | "topic" | "outside";
  method?: string;
  path: string;
  /** The gateway routes on the way, in order (`repo` of each). */
  through: string[];
  /** The specs read for it (`file:line`, the repo's or intake's). */
  specs: string[];
  /** Boundaries where both sides said something about the payload. */
  compared: number;
  mismatches: number;
  unconfirmed: number;
}

export interface ContractCheckResult {
  links: ContractLink[];
  findings: ContractMismatch[];
  counts: { links: number; compared: number; mismatches: number; unconfirmed: number };
}

export interface ContractCheckInput {
  repos: readonly { repo: string; facts: readonly Fact[] }[];
  join: FactsJoinResult;
  /** Every repo's `<repo>.specs.yaml` on file. */
  specs?: readonly SpecsFileT[];
  /** The specs of systems outside the estate, from intake. */
  outside?: readonly OutsideSpecs[];
  /** The calls to outside systems matched to their spec's operations (`joinVendorOperations`). */
  vendorMatches?: readonly VendorCallMatch[];
}

/** The words of the check, in one place: the CLI, the API and the app say these. */
export const CONTRACT_WORDS = {
  extra: (side: string, name: string, s: string, sAt: string, r: string) =>
    `${s} sends the ${side} field ${name} (${sAt}), which ${r} doesn't take`,
  notSent: (side: string, name: string, r: string, rAt: string, s: string) =>
    `${r} requires the ${side} field ${name} (${rAt}), which ${s} doesn't send`,
  missing: (name: string, s: string, sAt: string, r: string) =>
    `${s} reads the response field ${name} (${sAt}), which ${r} never returns`,
  messageMissing: (name: string, r: string, rAt: string, s: string) =>
    `${r} reads the message field ${name} (${rAt}), which ${s} never sends`,
  messageExtra: (name: string, s: string, sAt: string, r: string) =>
    `${s} sends the message field ${name} (${sAt}), which ${r} doesn't list`,
  undocumented: (name: string, r: string, rAt: string, s: string) =>
    `${r} returns the response field ${name} (${rAt}), which ${s} doesn't publish`,
  required: (side: string, name: string, a: string, aAt: string, b: string, bAt: string) =>
    side === "response"
      ? `${a} says the response field ${name} is always there (${aAt}); ${b} may leave it out (${bAt})`
      : `${a} may leave out the ${side} field ${name} (${aAt}); ${b} requires it (${bAt})`,
  type: (
    side: string,
    name: string,
    a: string,
    at: string,
    aAt: string,
    b: string,
    bt: string,
    bAt: string,
  ) => `the ${side} field ${name} is ${at} in ${a} (${aAt}) and ${bt} in ${b} (${bAt})`,
  number: (n: number, a: string, an: string, aAt: string, b: string, bn: string, bAt: string) =>
    `field number ${n} is ${an} in ${a} (${aAt}) and ${bn} in ${b} (${bAt}): a number reused for another field breaks every reader of the other`,
  errorUnlisted: (status: string, r: string, rAt: string, s: string, spec: boolean) =>
    `${r} answers ${status} (${rAt}), which ${s} doesn't ${spec ? "list" : "handle"}`,
  errorUnanswered: (status: string, s: string, sAt: string, r: string) =>
    `${s} lists the error ${status} (${sAt}), which ${r} never answers`,
  unconfirmed: (message: string, untraced: string) =>
    `${message}; unconfirmed: the mapping at ${untraced} isn't traced`,
};

// ------------------------------------------------------------------ faces

/** A field as it travels on the wire, with what it rests on. */
interface WireField {
  /** Every dotted segment normalised: case, `_`, `-` and `[]` aside. */
  key: string;
  /** The last segment's key: the fallback match when the paths differ. */
  tail: string;
  name: string;
  type?: string;
  required?: boolean;
  header: boolean;
  number?: number;
  at: string;
  /** The mapping lines that gave it its wire name. */
  via: string[];
  /** The untraced mapping it rests on (`repo path:line`), when one touches it. */
  untraced?: string;
}

type Side = "request" | "response" | "message";

/** One end of a boundary: what a call, an entry, a gateway route or a spec says about the payload. */
interface Face {
  what: string;
  repo?: string;
  system?: string;
  /** `published`: an own spec (it should document all it returns); `code`; `spec`: any other. */
  role: "published" | "code" | "spec";
  sides: Partial<Record<Side, WireField[]>>;
  /** Error status → its line. */
  errors?: Map<string, string>;
  /** spec file:line, when a spec. */
  spec?: string;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const seg = (s: string) =>
  s
    .toLowerCase()
    .replace(/\[\]/g, "")
    .replace(/[^a-z0-9]/g, "");
const keyOf = (name: string) => name.split(".").map(seg).filter(Boolean).join(".");
const tailOf = (name: string) => seg(name.split(".").pop() ?? name);
const atOf = (f: Fact) => `${f.cite.file}:${f.cite.line}`;
const where = (repo: string | undefined, at: string) => (repo ? `${repo} ${at}` : at);

/**
 * The `transform` a reader gives the field fact that names a publish's or listener's message type
 * (ADR 0164): the field's `name` is the type as the line writes it (`PaymentSettled`, the
 * generated proto class or the Avro record), its `type` the full name when the code gives one
 * (`forge.payments.v1.PaymentSettled`), cited where the publish or the listener names it. It is
 * no field of the payload: it ties the payload to its spec.
 */
export const MESSAGE_TYPE_TRANSFORM = "message type";
export const isMessageType = (f: { side?: string; transform?: string }) =>
  f.side === "message" && /^message[- ]type$/i.test((f.transform ?? "").trim());
/** A `transform` that says the field travels inside the field it is mapped to (an envelope). */
export const ENVELOPE_TRANSFORM = /\b(envelope|wrap(s|ped|per)?|inside|nested)\b/i;

const isOutbound = (owner: "entry" | "call", side: Side) =>
  (owner === "entry" && side === "response") || (owner === "call" && side !== "response");

/**
 * The wire fields of a fact's payload on one side: its field facts, an envelope's fields under
 * the envelope's name, a mapper's source replaced by the field it becomes (outbound) or its
 * target dropped (inbound), and a field with an untraced `transform` marked.
 */
function wireOf(
  facts: readonly Fact[],
  repo: string,
  owner: string,
  ownerKind: "entry" | "call",
  side: Side,
): WireField[] | undefined {
  const crossing = mappingFields(facts);
  const own = facts.filter(
    (f): f is Field =>
      f.kind === "field" &&
      f.owner === owner &&
      (f.side ?? "request") === side &&
      !isMessageType(f) &&
      !crossing.has(f.id),
  );
  if (!own.length) return undefined;
  const byId = new Map(own.map((f) => [f.id, f] as const));
  const out = new Map<string, WireField>();
  const dropped = new Set<string>();
  const extraVia = new Map<string, string[]>();
  const nameOf = (f: Field, depth = 0): string => {
    const t = f.mappedTo ? byId.get(f.mappedTo) : undefined;
    if (t && depth < 6 && ENVELOPE_TRANSFORM.test(f.transform ?? ""))
      return `${nameOf(t, depth + 1)}.${f.name}`;
    return f.name;
  };
  for (const f of own) {
    const t = f.mappedTo ? byId.get(f.mappedTo) : undefined;
    if (!t || ENVELOPE_TRANSFORM.test(f.transform ?? "")) continue;
    // A mapper on one payload: outbound, the target is what travels; inbound, the source is.
    const [gone, kept] = isOutbound(ownerKind, side) ? [f, t] : [t, f];
    dropped.add(gone.id);
    extraVia.set(kept.id, [...(extraVia.get(kept.id) ?? []), where(repo, atOf(gone))]);
  }
  for (const f of [...own].sort((a, b) => cmp(a.id, b.id))) {
    if (dropped.has(f.id)) continue;
    const name = nameOf(f);
    const t = f.mappedTo ? byId.get(f.mappedTo) : undefined;
    const envelope = t && ENVELOPE_TRANSFORM.test(f.transform ?? "");
    const untraced = !!f.transform && !f.mappedTo && !ENVELOPE_TRANSFORM.test(f.transform);
    const k = keyOf(name);
    if (out.has(k)) continue;
    out.set(k, {
      key: k,
      tail: tailOf(name),
      name,
      ...(f.type ? { type: f.type } : {}),
      ...(f.required !== undefined ? { required: f.required } : {}),
      header: side !== "message" && isHeaderName(f.name),
      at: atOf(f),
      via: [...(envelope ? [where(repo, atOf(t!))] : []), ...(extraVia.get(f.id) ?? [])],
      ...(untraced ? { untraced: where(repo, atOf(f)) } : {}),
    });
  }
  return [...out.values()].sort((a, b) => cmp(a.key, b.key));
}

/**
 * The field facts that are a mapping between two payloads, not a payload: a field of an entry or
 * a call `mappedTo` a field of another entry or call (a gateway policy's), and the field it maps
 * to. A field mapped to a column stays its payload's.
 */
function mappingFields(facts: readonly Fact[]): Set<string> {
  const byId = new Map<string, Fact>();
  for (const f of facts) byId.set(f.id, f);
  const payload = (f: Fact | undefined) => f?.kind === "entry" || f?.kind === "call";
  const out = new Set<string>();
  for (const f of facts) {
    if (f.kind !== "field" || !f.mappedTo) continue;
    const t = byId.get(f.mappedTo);
    if (t?.kind !== "field" || t.owner === f.owner) continue;
    if (payload(byId.get(f.owner)) && payload(byId.get(t.owner))) {
      out.add(f.id);
      out.add(t.id);
    }
  }
  return out;
}

/** The error statuses the flows give an entry or a call (ADR 0142's reading), each with its first line. */
const STATUS = /\b([45]\d\d)\b/g;
function flowErrors(facts: readonly Fact[], entry?: string, call?: string): Map<string, string> {
  const out = new Map<string, string>();
  const flows = facts
    .filter(
      (f): f is FactOf<"flow"> =>
        f.kind === "flow" &&
        ((!!entry && f.entry === entry) || (!!call && f.steps.some((s) => s.ref === call))),
    )
    .sort((a, b) => cmp(a.id, b.id));
  for (const f of flows)
    for (const e of f.errors)
      for (const m of `${e.when} ${e.then}`.matchAll(STATUS))
        if (!out.has(m[1]!)) out.set(m[1]!, `${e.cite.file}:${e.cite.line}`);
  return out;
}

function codeFace(facts: readonly Fact[], repo: string, fact: Entry | Call, what: string): Face {
  const ownerKind = fact.kind === "entry" ? "entry" : "call";
  const sides: Face["sides"] = {};
  for (const side of ["request", "response", "message"] as const) {
    const w = wireOf(facts, repo, fact.id, ownerKind, side);
    if (w) sides[side] = w;
  }
  const errors =
    fact.kind === "entry" ? flowErrors(facts, fact.id) : flowErrors(facts, undefined, fact.id);
  return { what, repo, role: "code", sides, ...(errors.size ? { errors } : {}) };
}

function specFace(
  s: ContractSpecT,
  what: string,
  role: Face["role"],
  repo?: string,
  system?: string,
): Face {
  const sides: Face["sides"] = {};
  for (const f of [...s.fields].sort((a, b) => cmp(a.name, b.name) || cmp(a.at, b.at))) {
    const list = (sides[f.side] ??= []);
    const k = keyOf(f.name);
    if (list.some((x) => x.key === k)) continue;
    list.push({
      key: k,
      tail: tailOf(f.name),
      name: f.name,
      ...(f.type ? { type: f.type } : {}),
      ...(f.required !== undefined ? { required: f.required } : {}),
      header: f.in === "header",
      ...(f.number !== undefined && s.format === "protobuf" ? { number: f.number } : {}),
      at: f.at,
      via: [],
    });
  }
  const errors = new Map((s.errors ?? []).map((e) => [e.status, e.at] as const));
  return {
    what,
    ...(repo ? { repo } : {}),
    ...(system ? { system } : {}),
    role,
    sides,
    ...(errors.size ? { errors } : {}),
    spec: `${s.file}:${s.line}`,
  };
}

const specName = (s: ContractSpecT) => s.file.split("/").pop() ?? s.file;

// ------------------------------------------------------------------ gateway hops

/** A hop's mappings: a published name ↔ the name its forwarding call uses, and what isn't traced. */
interface Hop {
  repo: string;
  pairs: { side: "request" | "response"; front: string; back: string; at: string }[];
  /** side → normalised name → `repo path:line` of the untraced mapping. */
  untraced: Map<string, string>;
}

function hopOf(facts: readonly Fact[], repo: string, route: string, forward: string): Hop {
  const fields = facts.filter(
    (f): f is Field => f.kind === "field" && (f.owner === route || f.owner === forward),
  );
  const byId = new Map(fields.map((f) => [f.id, f] as const));
  const pairs: Hop["pairs"] = [];
  const untraced = new Map<string, string>();
  for (const f of [...fields].sort((a, b) => cmp(a.id, b.id))) {
    const side = (f.side ?? "request") as Side;
    if (side === "message") continue;
    const t = f.mappedTo ? byId.get(f.mappedTo) : undefined;
    if (t && t.owner !== f.owner) {
      const [front, back] = f.owner === route ? [f, t] : [t, f];
      pairs.push({ side, front: front.name, back: back.name, at: where(repo, atOf(f)) });
    } else if (f.transform && !t) untraced.set(`${side}|${keyOf(f.name)}`, where(repo, atOf(f)));
  }
  return { repo, pairs, untraced };
}

/** A face as the hop's forwarding call carries it: published names turned into the service's. */
function translate(face: Face, hop: Hop, what: string): Face {
  const sides: Face["sides"] = {};
  for (const side of ["request", "response"] as const) {
    const list = face.sides[side];
    if (!list) continue;
    sides[side] = list.map((w) => {
      const p = hop.pairs.find((x) => x.side === side && keyOf(x.front) === w.key);
      const u = hop.untraced.get(`${side}|${w.key}`);
      const name = p ? p.back : w.name;
      return {
        ...w,
        key: keyOf(name),
        tail: tailOf(name),
        name,
        via: [...w.via, ...(p ? [p.at] : [])],
        ...(u ? { untraced: u } : {}),
      };
    });
  }
  // A name the hop sets on the service's side that nothing published carries (an untraced
  // policy's output) is untraced too: carried as an empty marker for the comparison below.
  return { ...face, what, sides, role: face.role };
}

/** Names an untraced policy at the hop writes on the service's side: a difference there is unconfirmed. */
function hopUntraced(hop: Hop | undefined, side: Side, key: string): string | undefined {
  return hop?.untraced.get(`${side}|${key}`);
}

// ------------------------------------------------------------------ the comparison

interface Ctx {
  base: Omit<ContractMismatch, "id" | "status" | "kind" | "sender" | "receiver" | "message">;
  key: string;
  boundary: number;
  out: ContractMismatch[];
  /** The hop between the two faces, when the comparison crosses one. */
  hop?: Hop;
  /** Whether a gateway stands between: its own statuses (401, 403, 429, 502-504) are its. */
  gateway: boolean;
  /** What the link has said already (see `push`). */
  said: Set<string>;
}

const GATEWAY_STATUSES = new Set(["401", "403", "429", "502", "503", "504"]);

function family(t: string | undefined): string | undefined {
  const x = (t ?? "").trim();
  if (/^repeated\s/i.test(x)) return "array";
  return typeFamily(x.replace(/^(optional|required)\s+/i, ""));
}

function push(
  ctx: Ctx,
  kind: ContractKind,
  side: Side | undefined,
  name: string,
  s: { face: Face; w?: WireField; value?: string },
  r: { face: Face; w?: WireField; value?: string },
  message: string,
) {
  const untraced = s.w?.untraced ?? r.w?.untraced;
  const end = (x: typeof s): ContractEnd => ({
    ...(x.face.repo ? { repo: x.face.repo } : {}),
    ...(x.face.system ? { system: x.face.system } : {}),
    what: x.face.what,
    ...(x.value ? { value: x.value } : x.w ? { value: x.w.type ?? x.w.name } : {}),
    ...(x.w ? { at: x.w.at } : {}),
  });
  const via = [...(s.w?.via ?? []), ...(r.w?.via ?? [])];
  // The same field of the same line, found again on another boundary of the link, is said once.
  const line = r.face.role === "code" ? r.w?.at : s.face.role === "code" ? s.w?.at : undefined;
  const same = `${ctx.key}|${kind}|${side ?? ""}|${keyOf(name)}|${line ?? ""}`;
  if (line && ctx.said.has(same)) return;
  ctx.said.add(same);
  ctx.out.push({
    ...ctx.base,
    id: `${ctx.key}#${ctx.boundary}:${kind}:${side ?? "-"}:${keyOf(name) || name}`,
    status: untraced ? "unconfirmed" : "mismatch",
    kind,
    ...(side ? { side } : {}),
    ...(kind.startsWith("error") ? { error: name } : { field: name }),
    sender: end(s),
    receiver: end(r),
    ...(via.length ? { via: [...new Set(via)] } : {}),
    ...(untraced ? { untraced } : {}),
    message: untraced ? CONTRACT_WORDS.unconfirmed(message, untraced) : message,
  });
}

/** Match a sender's field to the receiver's: the same path, else the one field with its last segment. */
function matchOf(w: WireField, list: readonly WireField[]): WireField | undefined {
  const same = list.find((x) => x.key === w.key);
  if (same) return same;
  const tails = list.filter((x) => x.tail === w.tail);
  return tails.length === 1 ? tails[0] : undefined;
}

/**
 * An untraced mapping on the other side that matched nothing (review item 1): a field with a
 * `transform` and no `mappedTo` that no field across the boundary matched may be the one a
 * missing or extra field became, renamed by the converter, so the difference is unconfirmed.
 * The first by name, preferring one of the same type family, so the finding cites one line.
 */
function strayUntraced(
  list: readonly WireField[] | undefined,
  matched: ReadonlySet<WireField>,
  across: readonly WireField[],
  like?: WireField,
): string | undefined {
  const stray = (list ?? []).filter((x) => x.untraced && !matched.has(x) && !matchOf(x, across));
  if (!stray.length) return undefined;
  const fam = family(like?.type);
  const same = fam ? stray.find((x) => family(x.type) === fam) : undefined;
  return (same ?? stray[0])!.untraced;
}

/** A field as the finding carries it, marked with the untraced mapping it may rest on. */
const marked = (w: WireField, u: string | undefined): WireField =>
  u && !w.untraced ? { ...w, untraced: u } : w;

/**
 * Compare a sender's face (who calls, or publishes) with the receiver's (who serves, or listens):
 * the request or message it sends against what the receiver takes, and the response the receiver
 * returns against what the sender reads. Returns whether anything was compared.
 */
function compare(S: Face, R: Face, ctx: Ctx): boolean {
  let compared = false;
  {
    const side = "request" as const;
    const sAll = S.sides[side];
    const rAll = R.sides[side];
    if (sAll?.length && rAll?.length) {
      compared = true;
      for (const header of [false, true]) {
        const sent = sAll.filter((w) => w.header === header);
        const took = rAll.filter((w) => w.header === header);
        // Headers are compared only where both sides name some; a body where both list fields.
        if (!sent.length || !took.length) continue;
        const matched = new Set<WireField>();
        const sentMatched = new Set<WireField>();
        for (const w of sent) {
          const t = matchOf(w, took);
          if (t) {
            matched.add(t);
            sentMatched.add(w);
          }
        }
        for (const w of sent) {
          const t = matchOf(w, took);
          if (!t) {
            if (header) continue;
            const u = hopUntraced(ctx.hop, side, w.key) ?? strayUntraced(took, matched, sent, w);
            push(
              ctx,
              "field-extra",
              side,
              w.name,
              { face: S, w: marked(w, u) },
              { face: R },
              CONTRACT_WORDS.extra(side, w.name, S.what, w.at, R.what),
            );
            continue;
          }
          fieldPair(ctx, side, w, t, S, R);
        }
        for (const t of took)
          if (t.required === true && !matched.has(t) && !matchOf(t, sent)) {
            const u =
              hopUntraced(ctx.hop, side, t.key) ?? strayUntraced(sent, sentMatched, took, t);
            push(
              ctx,
              "field-not-sent",
              side,
              t.name,
              { face: S, value: sent.map((x) => x.name).join(", ") },
              { face: R, w: marked(t, u) },
              CONTRACT_WORDS.notSent(side, t.name, R.what, t.at, S.what),
            );
          }
      }
    }
  }
  // A message: what the receiver reads must be sent; what is sent must be in a schema it is held to.
  const sent = S.sides.message;
  const took = R.sides.message;
  if (sent?.length && took?.length) {
    compared = true;
    const matched = new Set<WireField>();
    const tookMatched = new Set<WireField>();
    for (const t of took) {
      const w = matchOf(t, sent);
      if (w) {
        matched.add(w);
        tookMatched.add(t);
      }
    }
    for (const t of took) {
      const w = matchOf(t, sent);
      const u = w ? undefined : strayUntraced(sent, matched, took, t);
      if (w) fieldPair(ctx, "message", w, t, S, R);
      else if (R.role !== "code" && t.required === true)
        push(
          ctx,
          "field-not-sent",
          "message",
          t.name,
          { face: S, value: sent.map((x) => x.name).join(", ") },
          { face: R, w: marked(t, u) },
          CONTRACT_WORDS.notSent("message", t.name, R.what, t.at, S.what),
        );
      else if (R.role === "code" || S.role !== "code")
        push(
          ctx,
          "field-missing",
          "message",
          t.name,
          { face: S, value: sent.map((x) => x.name).join(", ") },
          { face: R, w: marked(t, u) },
          CONTRACT_WORDS.messageMissing(t.name, R.what, t.at, S.what),
        );
    }
    if (R.role !== "code")
      for (const w of sent)
        if (!matched.has(w) && !matchOf(w, took))
          push(
            ctx,
            "field-extra",
            "message",
            w.name,
            { face: S, w: marked(w, strayUntraced(took, tookMatched, sent, w)) },
            { face: R },
            CONTRACT_WORDS.messageExtra(w.name, S.what, w.at, R.what),
          );
  }
  const read = S.sides.response?.filter((w) => !w.header);
  const back = R.sides.response?.filter((w) => !w.header);
  if (read?.length && back?.length) {
    compared = true;
    const matched = new Set<WireField>();
    const readMatched = new Set<WireField>();
    for (const w of read) {
      const t = matchOf(w, back);
      if (t) {
        matched.add(t);
        readMatched.add(w);
      }
    }
    for (const w of read) {
      const t = matchOf(w, back);
      if (!t) {
        const u = hopUntraced(ctx.hop, "response", w.key) ?? strayUntraced(back, matched, read, w);
        push(
          ctx,
          "field-missing",
          "response",
          w.name,
          { face: S, w: marked(w, u) },
          { face: R },
          CONTRACT_WORDS.missing(w.name, S.what, w.at, R.what),
        );
        continue;
      }
      fieldPair(ctx, "response", w, t, S, R);
    }
    // A published spec documents all it returns; a caller reading less is normal.
    if (S.role === "published")
      for (const t of back)
        if (!matched.has(t) && !matchOf(t, read))
          push(
            ctx,
            "field-extra",
            "response",
            t.name,
            { face: S },
            { face: R, w: marked(t, strayUntraced(read, readMatched, back, t)) },
            CONTRACT_WORDS.undocumented(t.name, R.what, t.at, S.what),
          );
  }
  // Error statuses, where both sides list some.
  if (S.errors?.size && R.errors?.size) {
    compared = true;
    const spec = S.role !== "code";
    for (const [status, at] of [...R.errors].sort((a, b) => cmp(a[0], b[0])))
      if (!S.errors.has(status))
        push(
          ctx,
          "error-unlisted",
          undefined,
          status,
          { face: S, value: [...S.errors.keys()].sort().join(", ") },
          { face: R, value: status, w: errAt(at) },
          CONTRACT_WORDS.errorUnlisted(status, R.what, at, S.what, spec),
        );
    if (S.role === "published")
      for (const [status, at] of [...S.errors].sort((a, b) => cmp(a[0], b[0])))
        if (!R.errors.has(status) && !(ctx.gateway && GATEWAY_STATUSES.has(status)))
          push(
            ctx,
            "error-unanswered",
            undefined,
            status,
            { face: S, value: status, w: errAt(at) },
            { face: R, value: [...R.errors.keys()].sort().join(", ") },
            CONTRACT_WORDS.errorUnanswered(status, S.what, at, R.what),
          );
  }
  return compared;
}

const errAt = (at: string): WireField => ({
  key: "",
  tail: "",
  name: "",
  header: false,
  at,
  via: [],
});

/** One field both sides have: its type's family, whether it must be there, and its number. */
function fieldPair(ctx: Ctx, side: Side, w: WireField, t: WireField, S: Face, R: Face) {
  const a = family(w.type);
  const b = family(t.type);
  if (a && b && a !== b)
    push(
      ctx,
      "field-type",
      side,
      w.name,
      { face: S, w },
      { face: R, w: t },
      CONTRACT_WORDS.type(side, w.name, S.what, w.type!, w.at, R.what, t.type!, t.at),
    );
  if (side === "response") {
    if (w.required === true && t.required === false)
      push(
        ctx,
        "field-required",
        side,
        w.name,
        { face: S, w },
        { face: R, w: t },
        CONTRACT_WORDS.required(side, w.name, S.what, w.at, R.what, t.at),
      );
  } else if (w.required === false && t.required === true)
    push(
      ctx,
      "field-required",
      side,
      w.name,
      { face: S, w },
      { face: R, w: t },
      CONTRACT_WORDS.required(side, w.name, S.what, w.at, R.what, t.at),
    );
}

/**
 * Two message specs of one topic (the publisher's and a listener's copy): protobuf field numbers
 * given to another name or type. Names that differ by number only are compared by `compare`.
 */
function numbers(S: Face, R: Face, ctx: Ctx): boolean {
  const a = S.sides.message?.filter((w) => w.number !== undefined) ?? [];
  const b = R.sides.message?.filter((w) => w.number !== undefined) ?? [];
  if (!a.length || !b.length) return false;
  for (const w of a) {
    const t = b.find((x) => x.number === w.number);
    if (!t) continue;
    const fa = family(w.type);
    const fb = family(t.type);
    if (t.key !== w.key || (fa && fb && fa !== fb))
      push(
        ctx,
        "field-number",
        "message",
        String(w.number),
        { face: S, w, value: `${w.name} ${w.type ?? ""}`.trim() },
        { face: R, w: t, value: `${t.name} ${t.type ?? ""}`.trim() },
        CONTRACT_WORDS.number(
          w.number!,
          S.what,
          `${w.name}${w.type ? ` (${w.type})` : ""}`,
          w.at,
          R.what,
          `${t.name}${t.type ? ` (${t.type})` : ""}`,
          t.at,
        ),
      );
  }
  return true;
}

// ------------------------------------------------------------------ specs, found

const sameMethod = (a: string | undefined, b: string | undefined) =>
  !a || !b || a.toUpperCase() === b.toUpperCase();
const samePath = (a: string, b: string) => {
  const x = normalizePath(a).replace(/\{[^}]*\}/g, "{}");
  const y = normalizePath(b).replace(/\{[^}]*\}/g, "{}");
  return x === y;
};

/** The short and full names of a message type: `forge.payments.v1.PaymentSettled`, `PaymentSettled`. */
function typeNames(t: string): string[] {
  const clean = t.replace(/<.*>$/, "").trim();
  const last = clean.split(/[.$:/]/).pop() ?? clean;
  return [...new Set([clean.toLowerCase(), last.toLowerCase()])];
}

/** The message type a publish or listener names, from its `$message` field fact. */
function messageTypeOf(facts: readonly Fact[], owner: string): Field | undefined {
  return facts
    .filter((f): f is Field => f.kind === "field" && f.owner === owner && isMessageType(f))
    .sort((a, b) => cmp(a.id, b.id))[0];
}

interface Held {
  spec: ContractSpecT;
  repo?: string;
  system?: string;
}

// ------------------------------------------------------------------ the check

/** Compare the payload on both sides of every link the join made, and of every call to an outside system with a spec. */
export function checkContracts(input: ContractCheckInput): ContractCheckResult {
  const factsOf = new Map(input.repos.map((r) => [r.repo, r.facts] as const));
  const factOf = (repo: string, id: string) => factsOf.get(repo)?.find((f) => f.id === id);
  const specsOf = new Map<string, ContractSpecT[]>();
  for (const f of input.specs ?? [])
    specsOf.set(f.repo, [...(specsOf.get(f.repo) ?? []), ...f.specs]);
  const held: Held[] = [];
  for (const [repo, list] of [...specsOf].sort((a, b) => cmp(a[0], b[0])))
    for (const spec of list) held.push({ spec, repo });
  for (const o of [...(input.outside ?? [])].sort((a, b) => cmp(a.system, b.system)))
    for (const spec of o.specs) held.push({ spec, system: o.system });

  const findings: ContractMismatch[] = [];
  const links: ContractLink[] = [];

  /** The message spec for a type: the repo's own first, then the estate's, then intake's. */
  const messageSpec = (
    repo: string,
    type: string | undefined,
    topic: string,
    next?: string,
  ): Held | undefined => {
    const names = type ? typeNames(type) : [];
    const fits = (h: Held) =>
      h.spec.kind === "message" &&
      ((h.spec.name !== undefined &&
        names.length > 0 &&
        typeNames(h.spec.name).some((n) => names.includes(n))) ||
        (names.length === 0 && h.spec.topic === topic));
    return (
      held.find((h) => h.repo === repo && fits(h)) ??
      (next ? held.find((h) => h.repo === next && fits(h)) : undefined) ??
      held.find((h) => h.repo !== undefined && fits(h)) ??
      held.find((h) => h.system !== undefined && fits(h))
    );
  };
  const what = {
    call: (e: FactEnd) => `${e.repo}'s call`,
    entry: (e: FactEnd) => `${e.repo}'s entry`,
    publish: (e: FactEnd) => `${e.repo}'s publish`,
    listener: (e: FactEnd) => `${e.repo}'s listener`,
    spec: (h: Held) => `${h.repo ?? h.system}'s spec ${specName(h.spec)}`,
  };

  const run = (
    link: Omit<ContractLink, "compared" | "mismatches" | "unconfirmed">,
    body: (ctx: (boundary: number, o?: { hop?: Hop; gateway?: boolean }) => Ctx) => number,
  ) => {
    const start = findings.length;
    const base = {
      ...(link.interface ? { interface: link.interface } : {}),
      ...(link.interfaces ? { interfaces: link.interfaces } : {}),
      call: link.call,
      ...(link.entry ? { entry: link.entry } : {}),
      ...(link.system ? { system: link.system } : {}),
    };
    const said = new Set<string>();
    const compared = body((boundary, o) => ({
      said,
      base,
      key: link.key,
      boundary,
      out: findings,
      ...(o?.hop ? { hop: o.hop } : {}),
      gateway: o?.gateway ?? false,
    }));
    const mine = findings.slice(start);
    links.push({
      ...link,
      compared,
      mismatches: mine.filter((f) => f.status === "mismatch").length,
      unconfirmed: mine.filter((f) => f.status === "unconfirmed").length,
    });
  };

  // ---- REST calls joined to an entry, through any gateways
  const joins = [...input.join.joins].sort(
    (a, b) =>
      cmp(a.interface, b.interface) ||
      cmp(a.call.repo, b.call.repo) ||
      cmp(a.call.fact, b.call.fact),
  );
  // A gateway's forwarding call is a link of its own on the map, and a hop of the calls that
  // go through it: those calls compare it end to end, so it is checked there, once, and its own
  // link named on each finding.
  const callKey = (e: FactEnd) => `${e.repo}|${e.fact}`;
  const joinOfCall = new Map(joins.map((j) => [callKey(j.call), j] as const));
  const covered = new Set<string>();
  for (const j of joins) for (const h of j.gateway ?? []) covered.add(callKey(h.call));
  for (const j of joins) {
    const call = factOf(j.call.repo, j.call.fact);
    const entry = factOf(j.entry.repo, j.entry.fact);
    if (call?.kind !== "call" || entry?.kind !== "entry") continue;
    if (j.how === "topic" || j.callType !== "rest" || covered.has(callKey(j.call))) continue;
    restLink(j, call, entry);
  }

  function restLink(j: FactJoin, call: Call, entry: Entry) {
    const cFacts = factsOf.get(j.call.repo) ?? [];
    const eFacts = factsOf.get(j.entry.repo) ?? [];
    const specs: string[] = [];
    let caller = codeFace(cFacts, j.call.repo, call, what.call(j.call));
    // J3: a consumer's copy of the API it calls stands in for a call with no fields of its own.
    const consumer = (specsOf.get(j.call.repo) ?? []).find(
      (s) =>
        s.kind === "operation" &&
        s.role === "consumer" &&
        sameMethod(s.method, call.method) &&
        !!s.path &&
        samePath(s.path, call.path),
    );
    if (consumer) {
      specs.push(`${j.call.repo} ${consumer.file}:${consumer.line}`);
      if (!caller.sides.request && !caller.sides.response)
        caller = {
          ...specFace(
            consumer,
            what.spec({ spec: consumer, repo: j.call.repo }),
            "spec",
            j.call.repo,
          ),
          errors: caller.errors ?? new Map(),
        };
    }
    const service = codeFace(eFacts, j.entry.repo, entry, what.entry(j.entry));
    const hops = j.gateway ?? [];
    const also = hops.flatMap((h) => {
      const x = joinOfCall.get(callKey(h.call));
      return x ? [x.interface] : [];
    });
    run(
      {
        key: `${j.interface}|${j.call.repo}|${j.call.fact}`,
        interface: j.interface,
        ...(also.length ? { interfaces: [j.interface, ...also] } : {}),
        call: j.call,
        entry: j.entry,
        kind: "rest",
        ...(j.method ? { method: j.method } : {}),
        path: j.path,
        through: hops.map((h) => h.entry.repo),
        specs,
      },
      (ctx) => {
        let n = 0;
        let boundary = 0;
        let current: Face = caller;
        let lastHop: Hop | undefined;
        for (const h of hops) {
          const hFacts = factsOf.get(h.entry.repo) ?? [];
          const published = (specsOf.get(h.entry.repo) ?? []).find(
            (s) => s.kind === "operation" && s.role === "own" && s.entry === h.entry.fact,
          );
          const hop = hopOf(hFacts, h.entry.repo, h.entry.fact, h.call.fact);
          if (published) {
            specs.push(`${h.entry.repo} ${published.file}:${published.line}`);
            const face = specFace(
              published,
              what.spec({ spec: published, repo: h.entry.repo }),
              "published",
              h.entry.repo,
            );
            if (
              compare(
                current,
                face,
                ctx(boundary++, lastHop ? { hop: lastHop, gateway: true } : { gateway: true }),
              )
            )
              n++;
            current = face;
          }
          current = translate(current, hop, current.what);
          lastHop = hop;
        }
        if (
          compare(
            current,
            service,
            ctx(boundary, { ...(lastHop ? { hop: lastHop } : {}), gateway: hops.length > 0 }),
          )
        )
          n++;
        return n;
      },
    );
  }

  // ---- topics: each publish against each listener, and both against the topic's spec
  const topicJoins = joins.filter((j) => j.how === "topic");
  const doneSpec = new Set<string>();
  for (const j of topicJoins) {
    const call = factOf(j.call.repo, j.call.fact);
    const entry = factOf(j.entry.repo, j.entry.fact);
    if (call?.kind !== "call" || entry?.kind !== "entry") continue;
    const cFacts = factsOf.get(j.call.repo) ?? [];
    const eFacts = factsOf.get(j.entry.repo) ?? [];
    const pub = codeFace(cFacts, j.call.repo, call, what.publish(j.call));
    const lis = codeFace(eFacts, j.entry.repo, entry, what.listener(j.entry));
    const typeOf = (f: Field | undefined) => f?.type ?? f?.name;
    const pType = typeOf(messageTypeOf(cFacts, call.id));
    const lType = typeOf(messageTypeOf(eFacts, entry.id));
    const pSpec = messageSpec(j.call.repo, pType, j.path);
    const lSpec = messageSpec(j.entry.repo, lType ?? pType, j.path, j.call.repo);
    const specs = [pSpec, lSpec]
      .filter((h): h is Held => !!h)
      .map((h) => `${h.repo ?? h.system} ${h.spec.file}:${h.spec.line}`);
    run(
      {
        key: `${j.interface}|${j.call.repo}|${j.call.fact}|${j.entry.repo}|${j.entry.fact}`,
        interface: j.interface,
        call: j.call,
        entry: j.entry,
        kind: "topic",
        path: j.path,
        through: [],
        specs: [...new Set(specs)],
      },
      (ctx) => {
        let n = 0;
        if (compare(pub, lis, ctx(0))) n++;
        const pFace =
          pSpec && specFace(pSpec.spec, what.spec(pSpec), "spec", pSpec.repo, pSpec.system);
        const lFace =
          lSpec && specFace(lSpec.spec, what.spec(lSpec), "spec", lSpec.repo, lSpec.system);
        // The publisher against its spec, once per publish and spec.
        const pk = `${j.call.repo}|${j.call.fact}|${pFace?.spec ?? ""}`;
        if (pFace && !doneSpec.has(pk)) {
          doneSpec.add(pk);
          if (compare(pub, pFace, ctx(1))) n++;
        }
        // The listener against the spec it reads by, and that spec against the publisher's.
        if (lFace) {
          if (compare(lFace, lis, ctx(2))) n++;
          if (pFace && lSpec !== pSpec) {
            const c = ctx(3);
            if (numbers(pFace, lFace, c)) n++;
            if (compare(pFace, lFace, c)) n++;
          }
        }
        return n;
      },
    );
  }

  // ---- listeners whose publisher is outside the estate, read against an intaken spec
  const heard = new Set(topicJoins.map((j) => `${j.entry.repo}|${j.entry.fact}`));
  for (const r of [...input.repos].sort((a, b) => cmp(a.repo, b.repo)))
    for (const f of r.facts) {
      if (f.kind !== "entry" || f.entryType !== "event-topic" || heard.has(`${r.repo}|${f.id}`))
        continue;
      const mt = messageTypeOf(r.facts, f.id);
      const type = mt?.type ?? mt?.name;
      const h = messageSpec(r.repo, type, f.path);
      if (!h?.system) continue;
      const end: FactEnd = {
        repo: r.repo,
        fact: f.id,
        component: factIdPart(f.component ?? r.repo),
        at: atOf(f),
      };
      const lis = codeFace(r.facts, r.repo, f, `${r.repo}'s listener`);
      run(
        {
          key: `${h.system}|${r.repo}|${f.id}`,
          call: end,
          entry: end,
          system: h.system,
          kind: "outside",
          path: f.path,
          through: [],
          specs: [`${h.system} ${h.spec.file}:${h.spec.line}`],
        },
        (ctx) =>
          compare(specFace(h.spec, what.spec(h), "spec", undefined, h.system), lis, ctx(0)) ? 1 : 0,
      );
    }

  // ---- calls to an outside system, against the operation its spec publishes
  for (const m of [...(input.vendorMatches ?? [])].sort(
    (a, b) =>
      cmp(a.vendor, b.vendor) || cmp(a.call.repo, b.call.repo) || cmp(a.call.fact, b.call.fact),
  )) {
    const o = input.outside?.find((x) => x.system === m.vendor);
    const op = o?.specs.find((s) => s.kind === "operation" && s.id === m.operation);
    const call = factOf(m.call.repo, m.call.fact);
    if (!o || !op || call?.kind !== "call") continue;
    const cFacts = factsOf.get(m.call.repo) ?? [];
    let sender = codeFace(cFacts, m.call.repo, call, what.call(m.call));
    // A gateway's forwarding call with no fields of its own forwards its route's published payload.
    if (!sender.sides.request && !sender.sides.response && m.route) {
      const published = (specsOf.get(m.route.repo) ?? []).find(
        (s) => s.kind === "operation" && s.role === "own" && s.entry === m.route!.fact,
      );
      if (published)
        sender = translate(
          specFace(
            published,
            what.spec({ spec: published, repo: m.route.repo }),
            "spec",
            m.route.repo,
          ),
          hopOf(cFacts, m.call.repo, m.route.fact, m.call.fact),
          what.spec({ spec: published, repo: m.route.repo }),
        );
    }
    const receiver = specFace(op, `${o.name}'s spec ${specName(op)}`, "spec", undefined, o.system);
    run(
      {
        key: `${m.vendor}|${m.call.repo}|${m.call.fact}`,
        call: m.call,
        system: m.vendor,
        kind: "outside",
        ...(m.method ? { method: m.method } : {}),
        path: m.path,
        through: m.route && !m.direct ? [m.route.repo] : [],
        specs: [`${o.system} ${op.file}:${op.line}`],
      },
      (ctx) => (compare(sender, receiver, ctx(0, { gateway: !!m.route && !m.direct })) ? 1 : 0),
    );
  }

  findings.sort((a, b) => cmp(a.id, b.id));
  links.sort((a, b) => cmp(a.key, b.key));
  return {
    links,
    findings,
    counts: {
      links: links.length,
      compared: links.filter((l) => l.compared > 0).length,
      mismatches: findings.filter((f) => f.status === "mismatch").length,
      unconfirmed: findings.filter((f) => f.status === "unconfirmed").length,
    },
  };
}

/**
 * The findings a newer spec of an outside system brings (ADR 0164): those against `next` that
 * the same calls didn't have against `prev`, by kind, side and field. What the Outside systems
 * page shows when a vendor's or a team's new spec is taken in.
 */
export function newFindings(
  next: readonly ContractMismatch[],
  prev: readonly ContractMismatch[],
): ContractMismatch[] {
  const k = (f: ContractMismatch) =>
    `${f.call.repo}|${f.call.fact}|${f.kind}|${f.side ?? ""}|${keyOf(f.field ?? f.error ?? "")}`;
  const had = new Set(prev.map(k));
  return next.filter((f) => !had.has(k(f)));
}
