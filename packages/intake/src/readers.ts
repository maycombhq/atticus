import { createHash } from "node:crypto";
import { isMap, isScalar, LineCounter, parseDocument } from "yaml";
import { endpointId, parseRecord, type CatalogRecord } from "@maycombhq/core";
import { openapiExtractor } from "@maycombhq/extractors";
import type { RepoHandle, ScanContext } from "@maycombhq/sdk";

/**
 * Built-in readers for inputs that need no AI: partner specs (OpenAPI 3, Swagger 2, AsyncAPI)
 * and payload samples. A partner spec is the vendor's published contract, so what it says
 * about itself is verified; its paths are relative to the metarepo root and carry no repo.
 */

export const READERS = {
  openapi: `${openapiExtractor.id}@${openapiExtractor.version}`,
  asyncapi: "asyncapi@0.1.0",
  payload: "payload@0.1.0",
} as const;

type Rec = Record<string, unknown> & { id: string; evidence: Record<string, unknown>[] };

const short = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 6);

/** A one-file view of a spec so the repo extractor's OpenAPI logic reads it unchanged. */
function oneFile(path: string, text: string): RepoHandle {
  return {
    name: "",
    commit: "0000000",
    async *listFiles() {
      yield path;
    },
    async readText() {
      return text;
    },
  };
}

/** REST endpoints of an OpenAPI 3 or Swagger 2 partner spec, served by `component`. */
export async function readOpenApiSpec(
  path: string,
  text: string,
  component: string,
  scannedAt: string,
): Promise<CatalogRecord[]> {
  const ctx: ScanContext = { dialects: [], component, scannedAt, warn: () => undefined };
  const out: Rec[] = [];
  for await (const r of openapiExtractor.scan(oneFile(path, text), ctx)) {
    const e = r as unknown as Rec;
    out.push({
      ...e,
      id: endpointId(component, e.method as string, String(e.normalizedPath)),
      // no repo: the spec lives in the metarepo's inputs, not in a code repo
      evidence: e.evidence.map(({ repo: _repo, ...rest }) => rest),
    });
  }
  // Two operations with one name get a short path hash, as merge does (ADR 0017).
  const count = new Map<string, number>();
  for (const e of out) count.set(e.id, (count.get(e.id) ?? 0) + 1);
  for (const e of out)
    if ((count.get(e.id) ?? 0) > 1) e.id = `${e.id}-${short(String(e.normalizedPath))}`;
  return out.map(valid);
}

const topicId = (t: string) =>
  `topic.${t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;

/** Event topics of an AsyncAPI 2 or 3 partner spec (channel address, else its key). */
export function readAsyncApiSpec(path: string, text: string, component: string): CatalogRecord[] {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc });
  const channels = doc.get("channels");
  if (!isMap(channels)) return [];
  const out: CatalogRecord[] = [];
  for (const pair of channels.items) {
    if (!isScalar(pair.key)) continue;
    const ch = pair.value;
    const address = isMap(ch) ? ch.get("address") : undefined;
    const topic = String(typeof address === "string" && address ? address : pair.key.value);
    const line = pair.key.range ? lc.linePos(pair.key.range[0]).line : undefined;
    out.push(
      valid({
        schemaVersion: 1,
        kind: "Endpoint",
        id: topicId(topic),
        status: "current",
        confidence: "verified",
        component,
        endpointType: "event-topic",
        pathOrTopic: topic,
        schemaRefs: [],
        evidence: [{ source: "spec", path, ...(line ? { line } : {}), side: "definition" }],
      }),
    );
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v === "object" ? "object" : typeof v;
}

/**
 * The shape of a JSON payload sample: field names and types, in document order. Values are
 * discarded: samples can hold real data, and only the schema is a fact worth keeping.
 */
export function payloadFields(data: unknown): { name: string; type: string }[] {
  const out: { name: string; type: string }[] = [];
  const seen = new Set<string>();
  const add = (name: string, type: string) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ name, type });
  };
  const walk = (v: unknown, prefix: string) => {
    if (Array.isArray(v)) {
      const items = v.filter((x) => x !== undefined);
      const first = items[0];
      if (first === undefined) return;
      const name = `${prefix}[]`;
      add(name, typeOf(first));
      for (const x of items) if (typeOf(x) === "object" || Array.isArray(x)) walk(x, name);
      return;
    }
    if (typeof v === "object" && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        const name = prefix ? `${prefix}.${k}` : k;
        add(name, typeOf(x));
        if (typeof x === "object" && x !== null) walk(x, name);
      }
    }
  };
  if (Array.isArray(data)) walk(data, "");
  else walk(data, "");
  return out;
}

export function readPayload(path: string, id: string, data: unknown): CatalogRecord {
  return valid({
    schemaVersion: 1,
    kind: "Schema",
    id,
    status: "current",
    confidence: "inferred",
    format: "json-schema",
    ref: path,
    fields: payloadFields(data),
    evidence: [{ source: "document", path, side: "document" }],
  });
}

function valid(r: Record<string, unknown>): CatalogRecord {
  const p = parseRecord(r);
  if (!p.ok)
    throw new Error(
      `intake built an invalid ${String(r.kind)} ${String(r.id)}: ${p.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
    );
  return p.record;
}
