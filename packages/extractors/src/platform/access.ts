import type { CatalogRecord } from "@maycombhq/core";
import { defineExtractor, type RepoHandle, type ScanContext } from "@maycombhq/sdk";
import type { Ev } from "../facts.js";
import {
  loadManifests,
  MALFORMED_YAML,
  MANIFEST_GLOBS,
  readYamlDocs,
  sameScope,
  subDoc,
  warnSkipped,
  type K8sObject,
  type YamlDoc,
} from "./manifests.js";
import { arr, at, clipId, envOf, ev, isObj, readOrWarn, slug, str } from "./util.js";

const RBAC = /\bkind["']?\s*:\s*["']?(Cluster)?Role(Binding)?\b/;
const RBAC_KINDS = new Set(["Role", "ClusterRole", "RoleBinding", "ClusterRoleBinding"]);
const APIGEE = [
  "**/apiProducts*.json",
  "**/apiproducts/*.json",
  "**/apiProducts/*.json",
  "**/developerApps*.json",
  "**/edge.json",
];

/**
 * Access: Kubernetes RBAC and Apigee-style API products.
 *
 * A RoleBinding or ClusterRoleBinding gives each ServiceAccount and Group subject an
 * AccessGrant with the bound role's rules as "verb resource" permissions (a role that isn't
 * in the repo, such as the built-in `view`, is named instead). Users are never recorded.
 *
 * API products (apigee-config style apiProducts.json, or edge.json orgConfig) act as roles
 * over the proxies they bundle; developer apps become oauth-client grants on those proxies
 * with the products' scopes. The apigee extractor reads proxy bundles only, so nothing overlaps.
 * Terraform IAM is read by the gcp extractor.
 */
export const accessExtractor = defineExtractor({
  id: "access",
  version: "0.1.0",
  claims: [...new Set([...MANIFEST_GLOBS, ...APIGEE])],
  async *scan(repo, ctx) {
    yield* rbac(repo, ctx);
    yield* apigeeProducts(repo, ctx);
  },
});

/** "get configmaps", "list apps/deployments", "get secrets/ledger-config": one per verb and resource. */
function permissions(role: K8sObject): string[] {
  const out = new Set<string>();
  for (const rule of arr(role.obj.rules)) {
    const verbs = arr(at(rule, "verbs"))
      .map(str)
      .filter((x): x is string => !!x);
    const groups = arr(at(rule, "apiGroups")).map((g) => str(g) ?? "");
    const resources = arr(at(rule, "resources"))
      .map(str)
      .filter((x): x is string => !!x);
    const names = arr(at(rule, "resourceNames"))
      .map(str)
      .filter((x): x is string => !!x);
    const urls = arr(at(rule, "nonResourceURLs"))
      .map(str)
      .filter((x): x is string => !!x);
    for (const verb of verbs) {
      for (const g of groups.length > 0 ? groups : [""])
        for (const r of resources) {
          const res = g ? `${g}/${r}` : r;
          if (names.length === 0) out.add(`${verb} ${res}`);
          for (const n of names) out.add(`${verb} ${res}/${n}`);
        }
      for (const u of urls) out.add(`${verb} ${u}`);
    }
  }
  return [...out].sort();
}

async function* rbac(repo: RepoHandle, ctx: ScanContext): AsyncGenerator<CatalogRecord> {
  const set = await loadManifests(repo, ctx, RBAC);
  warnSkipped(ctx, set, RBAC_KINDS);
  const roles = set.objects.filter((o) => o.kind === "Role" || o.kind === "ClusterRole");
  for (const b of set.objects) {
    if (b.kind !== "RoleBinding" && b.kind !== "ClusterRoleBinding") continue;
    const refKind = str(at(b.obj, "roleRef", "kind"));
    const refName = str(at(b.obj, "roleRef", "name"));
    if (!refKind || !refName) continue;
    const role = roles.find(
      (r) =>
        r.kind === refKind && r.name === refName && (refKind === "ClusterRole" || sameScope(r, b)),
    );
    const perms = role ? permissions(role) : [`${refKind}/${refName}`];
    const ns = b.kind === "RoleBinding" ? (b.namespace ?? "default") : undefined;
    const resource = ns ? `namespace/${ns}` : "cluster";
    const env = envOf({ ...(b.namespace ? { namespace: b.namespace } : {}), path: b.file });
    const evidence: Ev[] = [ev(repo, "infrastructure", b.file, b.line())];
    if (role) evidence.push(ev(repo, "infrastructure", role.file, role.line()));
    for (const s of arr(at(b.obj, "subjects"))) {
      const kind = str(at(s, "kind"));
      const name = str(at(s, "name"));
      const subjectKind =
        kind === "ServiceAccount" ? "service-account" : kind === "Group" ? "group" : undefined;
      if (!name || !subjectKind) continue;
      yield {
        schemaVersion: 1,
        kind: "AccessGrant",
        id: clipId(`${slug(name)}.rbac.${slug(ns ?? "cluster")}.${slug(b.name)}`),
        status: "current",
        confidence: "verified",
        subjectKind,
        subject: name,
        resource,
        scopesOrPermissions: perms,
        ...(env ? { env } : {}),
        evidence,
      } as unknown as CatalogRecord;
    }
  }
}

// ------------------------------------------------------------------ Apigee-style API products

interface Found {
  doc: YamlDoc;
  path: string;
}

/** Proxy ids follow the apigee extractor: `gw-<proxy>`. */
const gw = (proxy: string) => `gw-${proxy}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");

const strings = (v: unknown) =>
  arr(v)
    .map(str)
    .filter((x): x is string => !!x);

async function* apigeeProducts(repo: RepoHandle, ctx: ScanContext): AsyncGenerator<CatalogRecord> {
  const products: Found[] = [];
  const apps: Found[] = [];
  for await (const path of repo.listFiles(APIGEE)) {
    const text = await readOrWarn(repo, ctx, path);
    if (text === undefined) continue;
    const doc = readYamlDocs(text, { cache: repo.parseCache, path })?.[0];
    if (!doc) {
      ctx.warn(MALFORMED_YAML, path);
      continue;
    }
    const v = doc.value;
    const productList = (d: YamlDoc) => {
      if (Array.isArray(d.value))
        d.value.forEach((_, i) => products.push({ doc: subDoc(d, [i]), path }));
      else if (isObj(d.value) && str(d.value.name)) products.push({ doc: d, path });
    };
    const appMap = (d: YamlDoc) => {
      // developer → [apps], or a plain list of apps. The developer key is never recorded.
      if (Array.isArray(d.value))
        d.value.forEach((_, i) => apps.push({ doc: subDoc(d, [i]), path }));
      else if (isObj(d.value))
        for (const [dev, list] of Object.entries(d.value))
          arr(list).forEach((_, i) => apps.push({ doc: subDoc(d, [dev, i]), path }));
    };
    if (/edge\.json$/.test(path)) {
      if (at(v, "orgConfig", "apiProducts") !== undefined)
        productList(subDoc(doc, ["orgConfig", "apiProducts"]));
      if (at(v, "orgConfig", "developerApps") !== undefined)
        appMap(subDoc(doc, ["orgConfig", "developerApps"]));
    } else if (/developerApps/i.test(path)) appMap(doc);
    else productList(doc);
  }

  const byName = new Map<string, Found>();
  for (const p of products) {
    const name = str(at(p.doc.value, "name"));
    if (!name || byName.has(name)) continue;
    byName.set(name, p);
    const proxies = strings(at(p.doc.value, "proxies"));
    const envs = strings(at(p.doc.value, "environments"));
    for (const proxy of proxies)
      yield grant(
        `${gw(proxy)}.product-${slug(name)}`,
        "role",
        name,
        proxy,
        strings(at(p.doc.value, "scopes")),
        envs.length === 1 ? envs[0] : undefined,
        [ev(repo, "gateway", p.path, p.doc.line(["name"]), "gateway")],
      );
  }

  for (const a of apps) {
    const name = str(at(a.doc.value, "name"));
    if (!name) continue;
    const productNames = arr(at(a.doc.value, "apiProducts"))
      .map((x) => str(x) ?? str(at(x, "apiproduct")) ?? str(at(x, "name")))
      .filter((x): x is string => !!x);
    const used = productNames.map((n) => byName.get(n)).filter((p): p is Found => !!p);
    const envSets = used.map((p) => strings(at(p.doc.value, "environments")));
    const env =
      envSets.length > 0 && envSets.every((e) => e.length === 1 && e[0] === envSets[0]![0])
        ? envSets[0]![0]
        : undefined;
    const proxies: string[] = [];
    for (const p of used)
      for (const x of strings(at(p.doc.value, "proxies")))
        if (!proxies.includes(x)) proxies.push(x);
    for (const proxy of proxies) {
      const via = used.filter((p) => strings(at(p.doc.value, "proxies")).includes(proxy));
      const scopes: string[] = [];
      for (const p of via)
        for (const s of strings(at(p.doc.value, "scopes"))) if (!scopes.includes(s)) scopes.push(s);
      yield grant(`${gw(proxy)}.app-${slug(name)}`, "oauth-client", name, proxy, scopes, env, [
        ev(repo, "gateway", a.path, a.doc.line(["name"]), "gateway"),
        ...via.map((p) => ev(repo, "gateway", p.path, p.doc.line(["name"]), "gateway")),
      ]);
    }
  }
}

function grant(
  id: string,
  subjectKind: string,
  subject: string,
  resource: string,
  scopes: string[],
  env: string | undefined,
  evidence: Ev[],
): CatalogRecord {
  return {
    schemaVersion: 1,
    kind: "AccessGrant",
    id: clipId(id),
    status: "current",
    confidence: "verified",
    subjectKind,
    subject,
    resource,
    scopesOrPermissions: scopes,
    ...(env ? { env } : {}),
    evidence,
  } as unknown as CatalogRecord;
}
