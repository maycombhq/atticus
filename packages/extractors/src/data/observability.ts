import type { CatalogRecord, EvidenceSource } from "@maycombhq/core";
import { defineExtractor } from "@maycombhq/sdk";
import type { z } from "zod";
import { componentOf, evidence } from "../facts.js";
import { flattenYaml } from "../lang/config.js";
import { attrOf, parseHcl } from "../platform/hcl.js";
import {
  get,
  isTestOrBuildPath,
  items,
  lineAt,
  pairs,
  parseYamlDoc,
  scalar,
  slug,
} from "./common.js";

type AssetKind = "log-config" | "metric" | "trace" | "alert" | "dashboard" | "runbook";

/** "LedgerApiHighErrorRate" → "Ledger Api High Error Rate"; names with spaces are left alone. */
const words = (name: string) =>
  /^[A-Za-z0-9]+$/.test(name)
    ? name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    : name;

/**
 * Observability asset ids: <component>.<assetKind>.<slug of the name>. Alerts drop a leading
 * component name, as the infra extractor does ("Ledger API error rate" on ledger-api →
 * ledger-api.alert.error-rate), so the same alert written two ways gets one id.
 */
export function observabilityAssetId(
  component: string,
  assetKind: AssetKind,
  name: string,
): string {
  const c = slug(component);
  let s = slug(words(name));
  if (assetKind === "alert" && s.startsWith(`${c}-`)) s = s.slice(c.length + 1);
  return `${c}.${assetKind}.${s || slug(name)}`;
}

/** A component named by a label or tag (component:, service:, app:), if any. */
function taggedComponent(tags: string[]): string | undefined {
  for (const key of ["component", "service", "app"]) {
    const t = tags.find((x) => x.startsWith(`${key}:`));
    if (t) return t.slice(key.length + 1).trim();
  }
  return undefined;
}

/**
 * Observability kept as code → ObservabilityAsset records:
 *   Prometheus rule files and PrometheusRule resources: alert rules (alert), recording rules (metric);
 *   Grafana dashboard JSON (dashboard, named by its title);
 *   Datadog monitors as JSON or Terraform datadog_monitor (alert), datadog_dashboard (dashboard);
 *   OpenTelemetry collector pipelines (traces → trace, metrics → metric, logs → log-config);
 *   logback, log4j2 and Serilog configuration (log-config);
 *   runbooks (runbooks/*.md, docs/runbook*.md) (runbook, named by the first heading).
 * The component is the one a label or tag names (component:, service:, app:), else the repo's.
 * Alert files in the Forge format (alerts: [...]) belong to the infra extractor.
 */
export const observabilityExtractor = defineExtractor({
  id: "observability",
  version: "1.0.0",
  claims: [
    "**/*rules*.yml",
    "**/*rules*.yaml",
    "**/prometheus/**/*.yml",
    "**/prometheus/**/*.yaml",
    "**/alerts/**/*.yml",
    "**/alerts/**/*.yaml",
    "**/monitoring/**/*.yml",
    "**/monitoring/**/*.yaml",
    "**/monitoring/**/*.json",
    "**/observability/**/*.yml",
    "**/observability/**/*.yaml",
    "**/observability/**/*.json",
    "**/grafana/**/*.json",
    "**/dashboards/**/*.json",
    "**/datadog/**/*.json",
    "**/monitors/**/*.json",
    "**/otel*.yml",
    "**/otel*.yaml",
    "**/*collector*.yml",
    "**/*collector*.yaml",
    "**/otel/**/*.yml",
    "**/otel/**/*.yaml",
    "**/logback*.xml",
    "**/log4j2*.xml",
    "**/log4j2*.yml",
    "**/log4j2*.yaml",
    "**/appsettings*.json",
    "**/serilog*.json",
    "**/runbooks/**/*.md",
    "**/runbook/**/*.md",
    "**/runbook*.md",
    "**/*.tf",
  ],
  async *scan(repo, ctx) {
    const fallback = componentOf(repo, ctx);
    const seen = new Set<string>();
    const asset = (
      component: string,
      assetKind: AssetKind,
      name: string,
      source: z.infer<typeof EvidenceSource>,
      path: string,
      line: number,
    ): CatalogRecord | undefined => {
      const id = observabilityAssetId(component, assetKind, name);
      if (seen.has(id)) return undefined;
      seen.add(id);
      return {
        schemaVersion: 1,
        kind: "ObservabilityAsset",
        id,
        status: "current",
        // A runbook is a document: it says what to do, it doesn't prove the system does it.
        confidence: source === "document" ? "inferred" : "verified",
        component: slug(component),
        assetKind,
        name,
        evidence: [evidence(repo, { source, path, line })],
      } as unknown as CatalogRecord;
    };
    const paths: string[] = [];
    for await (const p of repo.listFiles(this.claims)) if (!isTestOrBuildPath(p)) paths.push(p);
    for (const path of paths) {
      const base = path.split("/").pop()!;
      const text = await repo.readText(path);
      const out: (CatalogRecord | undefined)[] = [];

      if (path.endsWith(".md")) {
        if (/^readme\.md$/i.test(base)) continue;
        if (!/(^|\/)runbooks?\//i.test(path) && !/^runbook/i.test(base)) continue;
        let body = text;
        let offset = 0;
        let component = fallback;
        const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
        if (fm) {
          const meta = flattenYaml(fm[1]!, path);
          component = meta.get("component")?.value ?? meta.get("service")?.value ?? fallback;
          body = text.slice(fm[0].length);
          offset = fm[0].split("\n").length - 1;
        }
        const h = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(body);
        const name = h ? h[1]! : base.replace(/\.md$/i, "");
        const line = h ? offset + lineAt(body, h.index) : 1;
        out.push(asset(component, "runbook", name, "document", path, line));
      } else if (path.endsWith(".xml")) {
        const root = /<(configuration|Configuration)\b/.exec(text);
        if (root)
          out.push(asset(fallback, "log-config", base, "config", path, lineAt(text, root.index)));
      } else if (path.endsWith(".tf")) {
        // Terraform, read with the HCL parser: datadog_monitor (alert), datadog_dashboard (dashboard).
        for (const r of parseHcl(text).blocks) {
          const type = r.labels[0];
          if (r.type !== "resource" || (type !== "datadog_monitor" && type !== "datadog_dashboard"))
            continue;
          const monitor = type === "datadog_monitor";
          const str = (k: string) => {
            const v = attrOf(r, k);
            return typeof v === "string" ? v : undefined;
          };
          const name = monitor ? (str("name") ?? str("title")) : (str("title") ?? str("name"));
          if (!name) continue;
          const t = attrOf(r, "tags");
          const tags = Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [];
          out.push(
            asset(
              taggedComponent(tags) ?? fallback,
              monitor ? "alert" : "dashboard",
              name,
              "infrastructure",
              path,
              r.line,
            ),
          );
        }
      } else {
        const doc = parseYamlDoc(text);
        if (!doc) continue;
        const { root, lc } = doc;
        const top = pairs(root, lc);
        const has = (k: string) => top.some((p) => p.key === k);
        if (/^(appsettings|serilog).*\.json$/i.test(base)) {
          const s = get(root, "Serilog", lc);
          if (s) out.push(asset(fallback, "log-config", base, "config", path, s.line));
        } else if (/^log4j2/i.test(base)) {
          const c = get(root, "Configuration", lc);
          if (c) out.push(asset(fallback, "log-config", base, "config", path, c.line));
        } else if (has("groups") || get(get(root, "spec", lc)?.value, "groups", lc)) {
          // Prometheus rules, plain or as a PrometheusRule resource.
          const groups =
            get(root, "groups", lc) ?? get(get(root, "spec", lc)?.value, "groups", lc)!;
          for (const g of items(groups.value))
            for (const r of items(get(g, "rules", lc)?.value)) {
              const alert = get(r, "alert", lc);
              const record = get(r, "record", lc);
              const labels = pairs(get(r, "labels", lc)?.value, lc).map(
                (l) => `${l.key}:${scalar(l.value) ?? ""}`,
              );
              const component = taggedComponent(labels) ?? fallback;
              const named = alert ?? record;
              const name = named ? scalar(named.value) : undefined;
              if (!named || !name) continue;
              out.push(
                asset(
                  component,
                  alert ? "alert" : "metric",
                  name,
                  "infrastructure",
                  path,
                  named.line,
                ),
              );
            }
        } else if (has("receivers") && get(get(root, "service", lc)?.value, "pipelines", lc)) {
          const pipelines = get(get(root, "service", lc)!.value, "pipelines", lc)!;
          const file = base.replace(/\.ya?ml$/i, "");
          for (const p of pairs(pipelines.value, lc)) {
            const signal = p.key.split("/")[0];
            const kind: AssetKind | undefined =
              signal === "traces"
                ? "trace"
                : signal === "metrics"
                  ? "metric"
                  : signal === "logs"
                    ? "log-config"
                    : undefined;
            if (kind)
              out.push(asset(fallback, kind, `${file} ${p.key}`, "infrastructure", path, p.line));
          }
        } else {
          // Grafana dashboards (plain or wrapped by the API), Datadog monitors (one or a list).
          const dash =
            (has("panels") || has("rows")) && get(root, "title", lc)
              ? root
              : get(root, "dashboard", lc)?.value;
          const title = get(dash, "title", lc);
          const hasPanels = pairs(dash, lc).some((p) => p.key === "panels" || p.key === "rows");
          if (title && hasPanels && scalar(title.value)) {
            const tags = items(get(dash, "tags", lc)?.value).map((t) => scalar(t) ?? "");
            out.push(
              asset(
                taggedComponent(tags) ?? fallback,
                "dashboard",
                scalar(title.value)!,
                "infrastructure",
                path,
                title.line,
              ),
            );
          } else {
            const monitors = items(root).length > 0 ? items(root) : [root];
            for (const m of monitors) {
              const name = get(m, "name", lc);
              if (!name || !scalar(name.value) || !get(m, "query", lc) || !get(m, "type", lc))
                continue;
              const tags = items(get(m, "tags", lc)?.value).map((t) => scalar(t) ?? "");
              out.push(
                asset(
                  taggedComponent(tags) ?? fallback,
                  "alert",
                  scalar(name.value)!,
                  "infrastructure",
                  path,
                  name.line,
                ),
              );
            }
          }
        }
      }
      for (const r of out) if (r) yield r;
    }
  },
});
