import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { interfaceId, parseRecord, type CatalogRecord, type RecordOf } from "@maycombhq/core";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const FIX = join(HERE, "fixtures");
export const FORGE = join(HERE, "../../../fixtures/forge");

export type Capability = RecordOf<"Capability">;

export function record(r: Record<string, unknown>): CatalogRecord {
  const p = parseRecord({ schemaVersion: 2, status: "current", confidence: "verified", ...r });
  if (!p.ok) throw new Error(`${String(r.id)}: ${JSON.stringify(p.issues)}`);
  return p.record;
}

const rows = (file: string) =>
  parse(readFileSync(file, "utf8")) as (Record<string, unknown> & { id: string })[];

/** The expected Forge catalog (hand-written), as records. */
export const forgeRecords = (): CatalogRecord[] =>
  rows(join(FORGE, "expected/scan.yaml")).map((r) => record(r));

/** The hand-written expected features. */
export const expectedFeatures = (): Capability[] =>
  rows(join(FIX, "forge-features.yaml")).map((r) => record(r) as Capability);

const evKey = (e: Record<string, unknown>) =>
  `${String(e.repo ?? "")}:${String(e.path ?? "")}:${String(e.line ?? "")}:${String(e.side ?? "")}`;

/** A feature with evidence reduced to (repo, path, line, side), for comparing with a golden file. */
export function comparable(f: CatalogRecord): Record<string, unknown> {
  const { evidence, ...rest } = f as Capability;
  return { ...rest, evidence: [...new Set(evidence.map(evKey))].sort() };
}

const ev = (path: string, line = 1, side?: string) => ({
  source: "code",
  repo: "estate",
  path,
  line,
  ...(side ? { side } : {}),
});

/** Small invented estates for unit tests (Contoso, Fabrikam and generic names). */
export const build = {
  system: (id: string, boundary = "product", owner?: string) =>
    record({
      kind: "System",
      id,
      name: id[0]!.toUpperCase() + id.slice(1),
      boundary,
      ...(owner ? { owner } : {}),
      evidence: [ev(`${id}.yaml`)],
    }),
  component: (id: string, system: string, type = "service", file = `${id}/App.java`) =>
    record({ kind: "Component", id, system, repo: id, type, evidence: [ev(file)] }),
  endpoint: (component: string, method: string, path: string, file = "Api.java", line = 1) => {
    const norm = path.replace(/\{[^}]*\}/g, "{}");
    const last =
      norm
        .split("/")
        .filter((s) => s && s !== "{}")
        .pop() ?? "root";
    return record({
      kind: "Endpoint",
      id: `${component}.${method.toLowerCase()}-${last.replace(/s$/, "")}`,
      component,
      endpointType: "rest",
      method,
      pathOrTopic: path,
      normalizedPath: norm,
      evidence: [ev(`${component}/${file}`, line, "callee")],
    });
  },
  topic: (component: string, topic: string) =>
    record({
      kind: "Endpoint",
      id: `topic.${topic.replace(/[^a-z0-9]+/g, "-")}`,
      component,
      endpointType: "event-topic",
      pathOrTopic: topic,
      evidence: [ev(`topics/${topic}.yaml`, 1, "definition")],
    }),
  call: (
    from: string,
    to: string,
    method: string,
    path: string,
    o: { endpoint?: string; via?: string; file?: string; confidence?: string } = {},
  ) =>
    record({
      kind: "Interface",
      id: interfaceId(from, to, method, path),
      from,
      to,
      ...(o.endpoint ? { endpoint: o.endpoint } : {}),
      via: o.via ?? "direct",
      method,
      normalizedPath: path,
      sync: "sync",
      confidence: o.confidence ?? "verified",
      evidence: [ev(`${from}/${o.file ?? "Client.java"}`, 1, "caller")],
    }),
  event: (from: string, to: string, topic: string, file = "Listener.java") =>
    record({
      kind: "Interface",
      id: interfaceId(from, to, undefined, topic),
      from,
      to,
      endpoint: `topic.${topic.replace(/[^a-z0-9]+/g, "-")}`,
      via: "event-bus",
      normalizedPath: topic,
      sync: "async",
      evidence: [ev(`${from}/Publisher.java`, 1, "caller"), ev(`${to}/${file}`, 1, "callee")],
    }),
  table: (store: string, name: string, o: { readers?: string[]; writers?: string[] } = {}) =>
    record({
      kind: "Table",
      id: `${store}.${name}`,
      dataStore: store,
      name,
      tableKind: "table",
      readers: o.readers ?? [],
      writers: o.writers ?? [],
      evidence: [ev(`migrations/${name}.sql`)],
    }),
  schedule: (component: string, key: string) =>
    record({
      kind: "Setting",
      id: `${component}.${key.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
      component,
      settingKind: "config",
      key,
      valueOrRef: "0 2 * * *",
      evidence: [{ source: "infrastructure", repo: "estate", path: "k8s/cron.yaml", line: 4 }],
    }),
};
