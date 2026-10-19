import type { CatalogRecord } from "@maycombhq/core";
import { defineExtractor } from "@maycombhq/sdk";
import { componentOf, looseEnd, repoConfig, restEndpoint } from "./facts.js";
import { resolvePlaceholders, type ConfigValue } from "./lang/config.js";
import {
  attr,
  attrs,
  attrsShown,
  findAnnotation,
  parseJava,
  type Annotation,
  type Decl,
} from "./lang/java.js";
import { looksLikeSql, tablesInQuery } from "./lang/sql.js";
import { cleanJdbcUrl, SECRET_NAME } from "./backends/shared.js";
import { applyAnnotations, modelsFor, modelValues, wrapperCalls } from "./frameworks.js";

const MAPPINGS: Record<string, string | undefined> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH",
  RequestMapping: undefined,
};

/**
 * The HTTP method and path of a mapping annotation. RequestMapping without a method means any.
 * A path made from a constant (`@GetMapping(ApiPaths.BY_ID)`) is shown as ${ApiPaths.BY_ID} and
 * `named` is set: its value isn't known, so it can't make a verified endpoint.
 */
function mapping(a: Annotation): { method: string; paths: string[]; named: boolean } | undefined {
  if (!(a.name in MAPPINGS)) return undefined;
  const fixed = MAPPINGS[a.name];
  const methods = attrs(a, "method").map((m) => m.replace(/^.*\./, "").toUpperCase());
  const value = attrsShown(a, "value");
  const path = attrsShown(a, "path");
  const paths = [...value.values, ...path.values];
  return {
    method: fixed ?? methods[0] ?? "ANY",
    paths: paths.length > 0 ? paths : [""],
    named: value.named || path.named,
  };
}

const join = (a: string, b: string) => {
  const s = `${a.replace(/\/+$/, "")}/${b.replace(/^\/+/, "")}`.replace(/\/+$/, "");
  return s === ""
    ? "/"
    : s.startsWith("/") || /^[a-z]+:\/\//i.test(s) || s.startsWith("${")
      ? s
      : `/${s}`;
};

const REST_TEMPLATE: Record<string, string> = {
  getForObject: "GET",
  getForEntity: "GET",
  postForObject: "POST",
  postForEntity: "POST",
  postForLocation: "POST",
  put: "PUT",
  delete: "DELETE",
  patchForObject: "PATCH",
  exchange: "ANY",
};

/** Receivers that are HTTP clients by name, for calls whose URL isn't a literal (not map.put). */
const CLIENT_RECEIVER = /rest|template|client|http|web/i;

/** Annotations this extractor reads: what a framework model's annotations can stand for. */
export const READ_ANNOTATIONS = new Set([
  "RestController",
  "Controller",
  "RequestMapping",
  ...Object.keys(MAPPINGS),
  "FeignClient",
  "KafkaListener",
  "JmsListener",
]);

/** Packages whose use means a file talks to another system. */
export const CLIENT_PACKAGES = [
  "org.springframework.web.client",
  "org.springframework.web.reactive.function.client",
  "org.springframework.cloud.openfeign",
  "org.springframework.kafka",
  "org.springframework.jms",
  "org.apache.kafka",
  "javax.jms",
  "jakarta.jms",
  "com.ibm.mq",
];

const SETTING_KIND: [RegExp, string][] = [
  [/timeout/i, "timeout"],
  [/retr(y|ies)|max-?attempts/i, "retry"],
  [/circuit-?breaker|failure-?rate/i, "circuit-breaker"],
  [/rate-?limit|limit-?for-?period/i, "rate-limit"],
  [/pool|max-?connections/i, "pool"],
];
const GENERIC = new Set([
  "client",
  "clients",
  "config",
  "http",
  "feign",
  "rest",
  "spring",
  "resilience4j",
  "instances",
  "default",
  "properties",
]);

/** "ledger.client.read-timeout" → "ledger-read-timeout": stable ids for settings. */
export function settingSlug(key: string): string {
  return key
    .split(".")
    .filter((s) => !GENERIC.has(s.toLowerCase()))
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Spring and Spring Boot: REST controllers (Endpoint, side callee); Feign clients,
 * RestTemplate and WebClient calls (http-call loose ends, with ${...} placeholders resolved
 * from application config); Kafka publish and @KafkaListener; SQL in JdbcTemplate calls and
 * @Query; the datasource URL; and resilience settings (timeouts, retries, circuit breakers).
 */
export const springExtractor = defineExtractor({
  id: "spring",
  version: "1.0.0",
  claims: [
    "**/*.java",
    "**/*.kt",
    "**/application*.yml",
    "**/application*.yaml",
    "**/application*.properties",
  ],
  async *scan(repo, ctx) {
    const component = componentOf(repo, ctx);
    const config = await repoConfig(repo);
    const resolve = (s: string) => resolvePlaceholders(s, config);

    for await (const path of repo.listFiles(["**/*.java", "**/*.kt"])) {
      if (/(^|\/)src\/test\//.test(path)) continue;
      const src = await repo.readText(path);
      const housePackages = (ctx.frameworks ?? []).flatMap((m) => m.packages);
      if (
        !/springframework|@FeignClient|KafkaTemplate|JdbcTemplate|@KafkaListener/.test(src) &&
        !housePackages.some((p) => src.includes(p))
      )
        continue;
      const file = parseJava(src);
      const lines = src.split("\n");
      // House frameworks this file uses (ADR 0054): their annotations read as Spring's.
      const models = modelsFor(file, ctx.frameworks);
      applyAnnotations(file, models);
      const values = modelValues(models);
      // Names this file gives a value: same-file String constants and @Value fields
      // (base → ${nw.endpoints.payments}), so base + PAY reads as a URL resolve() can finish.
      const known = new Map<string, string>();
      for (const m of src.matchAll(
        /static\s+final\s+String\s+(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/g,
      ))
        known.set(m[1]!, m[2]!);
      for (const d of file.decls.filter((x) => x.kind === "field")) {
        const v = attr(findAnnotation(d, "Value"));
        if (v) known.set(d.name, v);
      }
      const fill = (shown: string) =>
        shown.replace(
          /\$\{([A-Za-z_][\w.]*)\}/g,
          (m, n: string) => known.get(n) ?? values.get(n)?.value ?? m,
        );
      // For a served path: only names whose value was learned from code or bytecode, so the
      // endpoint it makes can be verified.
      const fillVerified = (shown: string) =>
        shown.replace(/\$\{([A-Za-z_][\w.]*)\}/g, (m, n: string) => {
          const v = values.get(n);
          return v?.verified ? v.value : m;
        });

      // ---- serving side: controllers (collected, so what the file gave is known)
      const serving: CatalogRecord[] = [];
      for (const d of file.decls.filter((x) => x.kind === "method" && x.parent)) {
        const type = d.parent as Decl;
        const isController = !!findAnnotation(type, "RestController", "Controller");
        const feign = findAnnotation(type, "FeignClient");
        for (const a of d.annotations) {
          const m = mapping(a);
          if (!m) continue;
          const classMap = findAnnotation(type, "RequestMapping");
          const cm = classMap ? mapping(classMap) : undefined;
          const prefixes = cm?.paths ?? [""];
          for (const prefix of prefixes) {
            for (const p of m.paths) {
              const full = join(fillVerified(prefix), fillVerified(p));
              const named = full.includes("${");
              if (isController && !feign && named) {
                // A served path made from a constant: seen, but not known well enough to verify.
                serving.push(
                  looseEnd(repo, ctx, "http-endpoint", `${m.method} ${full}`, {
                    source: "code",
                    path,
                    line: a.line,
                    side: "callee",
                  }),
                );
              } else if (isController && !feign) {
                // Known only through a model a person or document wrote: inferred, not verified.
                const byPerson = [
                  a,
                  classMap,
                  findAnnotation(type, "RestController", "Controller"),
                ].some((x) => x?.from && !x.from.verified);
                serving.push(
                  restEndpoint(
                    repo,
                    component,
                    m.method,
                    full,
                    { source: "code", path, line: a.line, side: "callee" },
                    byPerson ? { confidence: "inferred" } : {},
                  ),
                );
              } else if (feign) {
                const url = attrsShown(feign, "url");
                const base =
                  url.values[0] ??
                  `http://${attr(feign, "name") ?? attr(feign, "value") ?? "unknown"}`;
                serving.push(
                  looseEnd(repo, ctx, "http-call", `${m.method} ${resolve(join(base, full))}`, {
                    source: "code",
                    path,
                    line: a.line,
                    side: "caller",
                  }),
                );
              }
            }
          }
        }
        // Spring Data @Query on repository methods.
        const q = findAnnotation(d, "Query");
        const qs = attr(q, "value");
        if (q && qs && looksLikeSql(qs)) {
          for (const t of tablesInQuery(qs))
            serving.push(
              looseEnd(repo, ctx, "db-access", `${t.access} ${t.table}`, {
                source: "code",
                path,
                line: q.line,
                side: "caller",
              }),
            );
        }
        // Kafka listeners.
        const listener = findAnnotation(d, "KafkaListener");
        // topics = Topics.PAYMENTS shows as ${Topics.PAYMENTS}: a loose end, never joined.
        for (const topic of attrsShown(listener, "topics").values) {
          serving.push(
            looseEnd(repo, ctx, "event-subscribe", resolve(topic), {
              source: "code",
              path,
              line: listener!.line,
              side: "callee",
            }),
          );
        }
        // JMS listeners (IBM MQ, ActiveMQ and others behind Spring JMS).
        const jms = findAnnotation(d, "JmsListener");
        for (const q of attrsShown(jms, "destination").values)
          serving.push(
            looseEnd(repo, ctx, "mq-subscribe", resolve(q), {
              source: "code",
              path,
              line: jms!.line,
              side: "callee",
            }),
          );
      }

      // ---- calling side: RestTemplate, WebClient, Kafka publish, JDBC
      const usesRest = /RestTemplate|RestClient/.test(src);
      const usesKafka = /KafkaTemplate/.test(src);
      const usesJms = /JmsTemplate|JmsListener/.test(src);
      const found: CatalogRecord[] = [];
      file.calls.forEach((c, i) => {
        const url = c.args[0];
        // An argument the code builds from names, filled from this file, resolved from config.
        const built = !url && c.shown[0] ? fill(c.shown[0]) : undefined;
        const client = CLIENT_RECEIVER.test(c.receiver ?? "");
        const target =
          url && /^(\/|https?:|\$\{)/.test(url) ? url : built && client ? built : undefined;
        if (usesRest && REST_TEMPLATE[c.method] && target) {
          let method = REST_TEMPLATE[c.method]!;
          if (method === "ANY")
            method = /HttpMethod\.(\w+)/.exec(lines[c.line - 1] ?? "")?.[1] ?? "ANY";
          found.push(
            looseEnd(repo, ctx, "http-call", `${method} ${resolve(target)}`, {
              source: "code",
              path,
              line: c.line,
              side: "caller",
            }),
          );
        }
        const uri = url ?? (c.shown[0] ? fill(c.shown[0]) : undefined);
        if (c.method === "uri" && uri) {
          const verb = file.calls
            .slice(Math.max(0, i - 3), i)
            .reverse()
            .find(
              (x) =>
                ["get", "post", "put", "delete", "patch"].includes(x.method) && x.args.length <= 1,
            );
          if (verb)
            found.push(
              looseEnd(repo, ctx, "http-call", `${verb.method.toUpperCase()} ${resolve(uri)}`, {
                source: "code",
                path,
                line: c.line,
                side: "caller",
              }),
            );
        }
        const topic =
          url && !/\s/.test(url)
            ? url
            : built && /kafka|template|producer/i.test(c.receiver ?? "")
              ? built
              : undefined;
        if (usesKafka && c.method === "send" && topic) {
          found.push(
            looseEnd(repo, ctx, "event-publish", resolve(topic), {
              source: "code",
              path,
              line: c.line,
              side: "caller",
            }),
          );
        }
        const queue = url ?? built;
        if (
          usesJms &&
          (c.method === "send" || c.method === "convertAndSend") &&
          // A JMS template by name: kafkaTemplate.send is Kafka's, not a queue.
          /jms/i.test(c.receiver ?? "") &&
          queue
        )
          found.push(
            looseEnd(repo, ctx, "mq-publish", resolve(queue), {
              source: "code",
              path,
              line: c.line,
              side: "caller",
            }),
          );
        for (const a of c.args) {
          if (a && looksLikeSql(a)) {
            for (const t of tablesInQuery(a))
              found.push(
                looseEnd(repo, ctx, "db-access", `${t.access} ${t.table}`, {
                  source: "code",
                  path,
                  line: c.line,
                  side: "caller",
                }),
              );
          }
        }
      });
      // Calls through a house framework's wrapper client (ADR 0054).
      for (const w of wrapperCalls(file, src, models, fill))
        found.push(
          looseEnd(repo, ctx, "http-call", `${w.method} ${resolve(w.url)}`, {
            source: "code",
            path,
            line: w.call.line,
            side: "caller",
          }),
        );
      // Negative space: a file that uses a client library but gave nothing is a gap to see.
      if (serving.length === 0 && found.length === 0) {
        const lib = [...CLIENT_PACKAGES, ...models.flatMap((m) => m.packages)].find((p) =>
          file.imports.some((i) => i.startsWith(p)),
        );
        if (lib) ctx.warn(`uses ${lib} but no call to it was read here`, path);
      }
      yield* serving;
      yield* found;
    }

    // ---- configuration: datasource and resilience settings
    const ds = config.get("spring.datasource.url") ?? config.get("spring.datasource.jdbc-url");
    // Never the raw value: a JDBC URL often carries the user and password.
    const dsUrl = ds ? cleanJdbcUrl(ds.value) : undefined;
    if (ds && dsUrl)
      yield looseEnd(repo, ctx, "db-connection", dsUrl, {
        source: "config",
        path: ds.file,
        line: ds.line,
        side: "caller",
      });
    yield* settings(repo.name, component, config);
  },
});

function* settings(
  repoName: string,
  component: string,
  config: Map<string, ConfigValue>,
): Generator<CatalogRecord> {
  for (const [key, v] of [...config.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const kind = SETTING_KIND.find(([re]) => re.test(key.split(".").pop() ?? ""))?.[1];
    if (!kind || v.value === "") continue;
    yield {
      schemaVersion: 1,
      kind: "Setting",
      id: `${component}.${settingSlug(key)}`,
      status: "current",
      confidence: "verified",
      component,
      settingKind: kind,
      key,
      valueOrRef: SECRET_NAME.test(key) ? "(secret)" : v.value,
      evidence: [{ source: "config", repo: repoName, path: v.file, line: v.line }],
    } as unknown as CatalogRecord;
  }
}
