import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type YAMLMap } from "yaml";
import { routeScore, type ContractEntryT, type ContractsFileT } from "@maycombhq/core";
import { readOpenApiDocument } from "@maycombhq/extractors";
import { denyListHits, safePathOf } from "./traffic.js";

/**
 * J3 (ADR 0151): the contract files a consumer keeps, read as text and JSON whatever the repo's
 * language: Pact files (consumer-driven contracts, spec v2, v3 and v4) and the OpenAPI specs of
 * the APIs it calls (read with R1's `readOpenApiDocument`, ADR 0130). Each request becomes an
 * entry citing its file and line; nothing is run and nothing is fetched. What is kept is the
 * request's shape, never its example values: a path loses its query string, fragment and matrix
 * params and has its id-looking segments as `{id}` (as a traffic import's), a server URL loses its
 * credentials and query, and a file the deny-list names a word of is left out whole.
 */

/** A server URL without its user info, query string or fragment, its path's ids as `{id}`. */
export function safeServerUrl(url: string): string | undefined {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/i.exec(url.trim());
  if (!m) {
    const p = safePathOf(url);
    return p === "/" ? undefined : p;
  }
  const host = m[2]!.replace(/^.*@/, "");
  if (!host) return undefined;
  const rest = (m[3] ?? "").split(/[?#]/, 1)[0] ?? "";
  const path = rest && rest !== "/" ? safePathOf(rest) : "";
  return `${m[1]!.toLowerCase()}${host}${path === "/" ? "" : (path ?? "")}`;
}

const str = (m: YAMLMap | undefined, key: string): string | undefined => {
  const v = m?.get(key);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};
const mapAt = (m: unknown, key: string): YAMLMap | undefined => {
  const v = isMap(m) ? m.get(key, true) : undefined;
  return isMap(v) ? v : undefined;
};

/**
 * The requests of a Pact file: each HTTP interaction's method and path, at the line of its path,
 * with the consumer and provider names the file gives. Message interactions (v3 `messages`, v4
 * `Asynchronous/Messages`) are not requests and are skipped. Undefined when the text isn't a
 * Pact file (no consumer, provider and interactions).
 */
export function readPactFile(text: string, file: string): ContractEntryT[] | undefined {
  const lc = new LineCounter();
  let doc;
  try {
    doc = parseDocument(text, { lineCounter: lc });
  } catch {
    return undefined;
  }
  if (doc.errors.length || !isMap(doc.contents)) return undefined;
  const root = doc.contents;
  const consumer = str(mapAt(root, "consumer"), "name");
  const provider = str(mapAt(root, "provider"), "name");
  const list = root.get("interactions", true);
  if (!consumer || !provider || !isSeq(list)) return undefined;
  const out: ContractEntryT[] = [];
  for (const it of list.items) {
    if (!isMap(it)) continue;
    const type = str(it, "type");
    if (type && !/http/i.test(type)) continue;
    const req = mapAt(it, "request");
    if (!req) continue;
    const method = str(req, "method");
    const pair = req.items.find((p) => isScalar(p.key) && p.key.value === "path");
    const path = pair && isScalar(pair.value) ? String(pair.value.value) : undefined;
    const safe = path?.startsWith("/") ? safePathOf(path) : undefined;
    if (!safe) continue;
    const range = (pair!.key as { range?: [number, number, number] }).range;
    out.push({
      format: "pact",
      file,
      line: range ? lc.linePos(range[0]).line : 1,
      consumer,
      provider,
      ...(method ? { method: method.toUpperCase() } : {}),
      path: safe,
    });
  }
  return out;
}

/**
 * The operations of an OpenAPI spec a consumer keeps for an API it calls: each with its method,
 * path and line, its `info.title` as the provider's name and its server URLs (a host a repo lists
 * names the provider). Empty when the repo's own entries serve one of its operations (the repo's
 * own spec, which R1 reads); undefined when the text isn't an OpenAPI document.
 */
export function readConsumerOpenApi(
  text: string,
  file: string,
  own: readonly { method?: string; path: string }[],
): ContractEntryT[] | undefined {
  let read;
  try {
    read = readOpenApiDocument(text);
  } catch {
    return undefined;
  }
  if (!read) return undefined;
  const served = read.operations.some((op) =>
    own.some(
      (e) =>
        (!e.method || e.method.toUpperCase() === op.method.toUpperCase()) &&
        routeScore(op.path, e.path) >= 500,
    ),
  );
  if (served) return [];
  const title = read.doc.getIn(["info", "title"]);
  const provider = typeof title === "string" && title.trim() ? title.trim() : undefined;
  const hosts = [...new Set(read.servers.map(safeServerUrl).filter((h): h is string => !!h))];
  return read.operations.flatMap((op) => {
    const path = safePathOf(op.path);
    return path
      ? [
          {
            format: "openapi" as const,
            file,
            line: op.methodLine ?? op.line ?? 1,
            ...(provider ? { provider } : {}),
            ...(hosts.length ? { hosts } : {}),
            method: op.method.toUpperCase(),
            path,
          },
        ]
      : [];
  });
}

/** Folders never read for contract files: dependencies, builds and tool state. */
const SKIP = new Set([
  ".git",
  "node_modules",
  "vendor",
  "target",
  "build",
  "dist",
  "out",
  ".venv",
  "venv",
  "__pycache__",
  ".gradle",
  ".idea",
  ".atticus",
]);
const MAX_BYTES = 5 * 1024 * 1024;
const PACT = /pact/i;
const SPEC = /(openapi|swagger)/i;

/**
 * Every contract file in a checkout, as the facts companion `<repo>.contracts.yaml` holds them:
 * `.json` files under a path that says `pact`, and OpenAPI files (named `openapi` or `swagger`)
 * that the repo's own entries don't serve. Entries in file and line order. A file whose entries
 * hold a word the deny-list names (`denyHashes`, the `.denylist` format) is left out whole, and
 * `onRefused` is told which file (never the word).
 */
export async function readContractFiles(
  dir: string,
  o: {
    repo: string;
    commit?: string;
    own?: readonly { method?: string; path: string }[];
    denyHashes?: ReadonlySet<string>;
    onRefused?: (note: string) => void;
  },
): Promise<ContractsFileT> {
  const files: string[] = [];
  const walk = async (rel: string) => {
    const entries = await readdir(join(dir, ...rel.split("/").filter(Boolean)), {
      withFileTypes: true,
    }).catch(() => []);
    for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) await walk(p);
      } else if (e.isFile()) {
        if (/\.json$/i.test(e.name) && PACT.test(p)) files.push(p);
        else if (/\.(ya?ml|json)$/i.test(e.name) && SPEC.test(e.name)) files.push(p);
      }
    }
  };
  await walk("");
  const entries: ContractEntryT[] = [];
  for (const p of files) {
    const full = join(dir, ...p.split("/"));
    const size = (await stat(full).catch(() => undefined))?.size ?? 0;
    if (size === 0 || size > MAX_BYTES) continue;
    const text = await readFile(full, "utf8");
    const got =
      (/\.json$/i.test(p) && PACT.test(p) ? readPactFile(text, p) : undefined) ??
      (SPEC.test(p) ? readConsumerOpenApi(text, p, o.own ?? []) : undefined);
    if (!got?.length) continue;
    if (o.denyHashes?.size) {
      const text = got
        .map((e) =>
          [e.file, e.consumer, e.provider, ...(e.hosts ?? []), e.method, e.path].join("\n"),
        )
        .join("\n");
      if (denyListHits(text, o.denyHashes).length) {
        o.onRefused?.(`${p}: the deny-list names a word in it, so its requests are left out.`);
        continue;
      }
    }
    entries.push(...got);
  }
  entries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return {
    schemaVersion: 1,
    repo: o.repo,
    ...(o.commit ? { commit: o.commit } : {}),
    entries,
  };
}
