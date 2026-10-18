import type { CatalogRecord } from "@maycombhq/core";
import { defineExtractor } from "@maycombhq/sdk";
import { evidence } from "./facts.js";
import { parseXml, select, selectText } from "./lang/xml.js";

/**
 * Apigee-style API proxy bundles (`<proxy>/apiproxy/...`): one GatewayRoute per proxy with
 * its base path, target URL, policies in flow order and OAuth scopes; and an AccessGrant
 * for the scopes the proxy checks (the subject is filled in by merge from callers).
 */
export const apigeeExtractor = defineExtractor({
  id: "apigee",
  version: "1.0.0",
  claims: [
    "**/apiproxy/*.xml",
    "**/apiproxy/proxies/*.xml",
    "**/apiproxy/targets/*.xml",
    "**/apiproxy/policies/*.xml",
  ],
  async *scan(repo) {
    const byProxy = new Map<string, string[]>();
    for await (const p of repo.listFiles(this.claims)) {
      const dir = p.slice(0, p.indexOf("/apiproxy/") + "/apiproxy".length);
      byProxy.set(dir, [...(byProxy.get(dir) ?? []), p]);
    }
    for (const [dir, files] of [...byProxy.entries()].sort()) {
      const read = async (f: string) => parseXml(await repo.readText(f));
      const top = files.find((f) => f.slice(dir.length + 1).split("/").length === 1);
      const topXml = top ? await read(top) : undefined;
      const proxy = topXml?.attrs.name ?? dir.split("/").at(-2) ?? dir;

      let basepath: { text: string; line: number; file: string } | undefined;
      const steps: string[] = [];
      let targetName: string | undefined;
      for (const f of files.filter((x) => x.includes("/proxies/"))) {
        const x = await read(f);
        const bp = selectText(x, "ProxyEndpoint/HTTPProxyConnection/BasePath");
        if (bp && !basepath) basepath = { ...bp, file: f };
        for (const s of select(x, "//Step/Name"))
          if (!steps.includes(s.text.trim())) steps.push(s.text.trim());
        targetName ??= selectText(x, "//RouteRule/TargetEndpoint")?.text;
      }
      let target: { text: string; line: number; file: string } | undefined;
      for (const f of files.filter((x) => x.includes("/targets/"))) {
        const x = await read(f);
        if (targetName && x?.attrs.name && x.attrs.name !== targetName) continue;
        const url = selectText(x, "TargetEndpoint/HTTPTargetConnection/URL");
        if (url) target = { ...url, file: f };
      }
      const scopes: { scopes: string[]; line: number; file: string; policy: string }[] = [];
      for (const f of files.filter((x) => x.includes("/policies/"))) {
        const x = await read(f);
        if (x?.name === "OAuthV2") {
          const sc = selectText(x, "OAuthV2/Scope");
          if (sc)
            scopes.push({
              scopes: sc.text.split(/\s+/).filter(Boolean),
              line: sc.line,
              file: f,
              policy: x.attrs.name ?? "OAuthV2",
            });
        }
      }
      if (!basepath) continue;
      const id = `gw-${proxy}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
      const allScopes = [...new Set(scopes.flatMap((s) => s.scopes))];
      yield {
        schemaVersion: 1,
        kind: "GatewayRoute",
        id,
        status: "current",
        confidence: "verified",
        proxy,
        basepath: basepath.text,
        ...(target ? { target: target.text } : {}),
        policies: steps,
        scopes: allScopes,
        evidence: [
          evidence(repo, {
            source: "gateway",
            path: basepath.file,
            line: basepath.line,
            side: "gateway",
          }),
          ...(target
            ? [
                evidence(repo, {
                  source: "gateway",
                  path: target.file,
                  line: target.line,
                  side: "gateway",
                }),
              ]
            : []),
        ],
      } as unknown as CatalogRecord;
      for (const s of scopes) {
        yield {
          schemaVersion: 1,
          kind: "AccessGrant",
          id: `${id}.oauth-scopes`,
          status: "current",
          confidence: "inferred",
          subjectKind: "oauth-client",
          subject: "unknown",
          resource: proxy,
          scopesOrPermissions: s.scopes,
          evidence: [
            evidence(repo, { source: "gateway", path: s.file, line: s.line, side: "gateway" }),
          ],
        } as unknown as CatalogRecord;
      }
    }
  },
});
