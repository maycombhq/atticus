import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { factsDirOf, type Fact } from "@maycombhq/core";
import { factsSnapshotWrites } from "@maycombhq/scanner";
import { initCommand } from "../src/setup-commands.js";

/**
 * A large Forge estate for the speed of `verify <repo> --write`, the Connect panel's read and the
 * pairing preview (beta.28.1, field report 6): `repos` repos of one Spring Boot service each, each
 * with REST entries and their request and response fields, calls to other repos' entries by
 * their hosts (and some to hosts no repo lists, and some to an unresolved deploy token), tables
 * with columns and settings. At the defaults (60 repos) the build makes about 100,000 catalog
 * records from about 200,000 facts. Every repo's facts are verified and in its facts snapshot,
 * as `verify --write` of each leaves them, and its working facts file; `checkouts` repos get a
 * checkout whose lines hold what their facts cite, so `verify` itself accepts them.
 *
 * Deterministic for a seed: the same options give the same files. Invented names only.
 */
export interface BigEstateOptions {
  repos?: number;
  /** REST entries per repo (each with 2 request and 2 response fields). */
  entries?: number;
  /** Calls per repo to other repos' entries. */
  calls?: number;
  /** Tables per repo (5 columns each). */
  tables?: number;
  /** Settings per repo. */
  settings?: number;
  /** Repos (the first ones) given a checkout under workspace/. */
  checkouts?: number;
  seed?: number;
  /**
   * Gateway proxy repos (field report 2's estate, as fixtures/gateway-facts/policy-tokens): proxy
   * g is a repo of its own on the one gateway host, fronting service g's first `routes` entries
   * under the base path `/svc-NN/1.0`, its target URL a deploy token its config.json sets per
   * environment (prod to the service's host). Half of the calls to a fronted service go through
   * the gateway's host. None by default.
   */
  gateways?: number;
  /** Routes per gateway proxy. */
  routes?: number;
  /**
   * Clusters of repos (repo r in cluster r mod clusters): calls stay in a repo's cluster and each
   * cluster's paths use nouns of its own, so each cluster's flows are features of their own (with
   * one, the default, the estate's flows are one feature). Each cluster needs two repos or more.
   */
  clusters?: number;
}

export const BIG_COMMIT = "1111aaa";
const NOUNS = [
  "account",
  "balance",
  "payment",
  "transfer",
  "invoice",
  "statement",
  "ledger",
  "entry",
  "customer",
  "card",
  "limit",
  "fee",
  "rate",
  "report",
  "audit",
  "notice",
  "mandate",
  "refund",
  "dispute",
  "branch",
];
const METHODS = ["GET", "POST", "PUT", "DELETE"] as const;
const ANNOTATION: Record<string, string> = {
  GET: "GetMapping",
  POST: "PostMapping",
  PUT: "PutMapping",
  DELETE: "DeleteMapping",
};
const pad = (n: number) => String(n).padStart(2, "0");
export const bigRepoId = (r: number) => `forge-svc-${pad(r)}`;
const hostOf = (r: number) => `${bigRepoId(r)}.forge.example`;
export const bigGatewayId = (g: number) => `forge-gw-${pad(g)}`;
const GATEWAY_HOST = "gw.forge.example";
const basePathOf = (g: number) => `/svc-${pad(g)}/1.0`;
/** The nouns repo r's paths use: all of them, or its cluster's own (`clusters`). */
const nounsOf = (r: number, clusters: number) =>
  clusters > 1 ? NOUNS.filter((_, i) => i % clusters === r % clusters) : NOUNS;
const entryPath = (r: number, k: number, clusters = 1) => {
  const ns = nounsOf(r, clusters);
  return `/v1/${ns[(r + k) % ns.length]}s/{id}/${ns[(r * 3 + k * 7) % ns.length]}-${k}`;
};

/** mulberry32, as packages/synth. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lines of the checkout's files, by path, as a repo's facts cite them. */
type Files = Map<string, string[]>;

function cited(files: Files, file: string, text: string): { file: string; line: number } {
  const lines = files.get(file) ?? [];
  if (!files.has(file)) files.set(file, lines);
  lines.push(text);
  return { file, line: lines.length };
}

/** One repo's facts, and the lines its checkout holds for them. */
export function bigRepoFacts(
  r: number,
  o: ReturnType<typeof defaults>,
  /** A change: the repo's facts as of its n-th edit (0: as generated). */
  edit = 0,
): { facts: Fact[]; files: Files } {
  const repo = bigRepoId(r);
  const rnd = prng(o.seed * 1000 + r * 31);
  const files: Files = new Map();
  const facts: Fact[] = [];
  const base = { repo, commit: BIG_COMMIT, verified: "line", by: "assistant", conf: "declared" };
  const push = (f: Record<string, unknown>) => facts.push({ ...base, ...f } as unknown as Fact);
  // An edit moves a few entries' paths and drops a few calls, as a real change does.
  const moved = (k: number) => edit > 0 && k % 97 === edit % 97;
  for (let k = 0; k < o.entries; k++) {
    const method = METHODS[k % 4]!;
    const at = entryPath(r, k, o.clusters);
    const path = moved(k) ? `${at}-v${edit + 1}` : at;
    const file = `src/main/java/forge/web/${NOUNS[k % NOUNS.length]![0]!.toUpperCase()}${NOUNS[k % NOUNS.length]!.slice(1)}Controller${Math.floor(k / 40)}.java`;
    const c = cited(files, file, `    @${ANNOTATION[method]}("${path}")`);
    const id = `e-${k}`;
    push({
      kind: "entry",
      id,
      entryType: "rest",
      method,
      path,
      handler: `handle${k}`,
      cite: { ...c, value: path, quote: `@${ANNOTATION[method]}("${path}")` },
    });
    for (const [side, names] of [
      ["request", ["accountId", "amount"]],
      ["response", ["status", "reference"]],
    ] as const)
      for (const name of names) {
        const fc = cited(files, file, `        private String ${name}; // ${side}`);
        push({
          kind: "field",
          id: `${id}.${side}.${name.toLowerCase()}`,
          owner: id,
          side,
          name,
          type: "string",
          cite: { ...fc, value: name, quote: `private String ${name};` },
        });
      }
  }
  for (let k = 0; k < o.calls; k++) {
    if (edit > 0 && k % 53 === edit % 53) continue;
    const file = `src/main/java/forge/client/Client${Math.floor(k / 25)}.java`;
    const kind = rnd();
    // Most go to another repo's entry by its host; some to a host no repo lists (outside), some
    // to an unresolved deploy token (a loose end).
    let host: string;
    let path: string;
    let method: string;
    if (kind < 0.85) {
      // Another repo of its cluster (every other repo, with one cluster).
      const c = o.clusters;
      const mates = Math.ceil((o.repos - (r % c)) / c);
      const to =
        c > 1
          ? (r % c) + c * ((Math.floor(r / c) + 1 + Math.floor(rnd() * (mates - 1))) % mates)
          : (r + 1 + Math.floor(rnd() * (o.repos - 1))) % o.repos;
      const e = Math.floor(rnd() * o.entries);
      host = hostOf(to);
      path = entryPath(to, e, c);
      method = METHODS[e % 4]!;
      // Through the gateway: a route of the proxy that fronts the service (no draw without
      // gateways, so an estate without them is the one it always was).
      if (to < o.gateways && rnd() < 0.5) {
        const k = e % o.routes;
        host = GATEWAY_HOST;
        path = basePathOf(to) + entryPath(to, k, c);
        method = METHODS[k % 4]!;
      }
    } else if (kind < 0.95) {
      host = `api.northwind-pay.example`;
      path = `/v2/${NOUNS[k % NOUNS.length]}s/{id}`;
      method = "POST";
    } else {
      host = `@forgeTargetUrl${k % 3}@`;
      path = `/v1/${NOUNS[(k * 3) % NOUNS.length]}s/{id}`;
      method = "GET";
    }
    const url = `https://${host}${path}`;
    const c = cited(
      files,
      file,
      `        rest.exchange("${url}", HttpMethod.${method}, null, Item.class);`,
    );
    push({
      kind: "call",
      id: `c-${k}`,
      callType: "rest",
      method,
      path,
      host,
      from: `e-${k % o.entries}`,
      cite: { ...c, value: path, quote: `rest.exchange("${url}"` },
    });
  }
  for (let k = 0; k < o.tables; k++) {
    const file = `src/main/java/forge/data/Repo${Math.floor(k / 10)}.java`;
    const name = `${NOUNS[k % NOUNS.length]}_${k}`;
    const columns = ["id", "account_id", "amount", "status", "created_at"];
    const c = cited(files, file, `    @Query("select * from ${name} where id = ?")`);
    push({
      kind: "store",
      id: `s-${k}`,
      store: `${repo}-db`,
      storeType: "postgres",
      name,
      op: k % 3 === 0 ? "write" : "read",
      tableKind: "table",
      columns,
      under: `e-${k % o.entries}`,
      cite: { ...c, value: name, quote: `select * from ${name}` },
    });
  }
  for (let k = 0; k < o.settings; k++) {
    const key = `forge.${NOUNS[k % NOUNS.length]}.setting-${k}`;
    const value = String(1000 + ((k * 37 + r) % 9000));
    const c = cited(files, "src/main/resources/application.yml", `${key}: ${value}`);
    push({
      kind: "config",
      id: `k-${k}`,
      settingKind: "config",
      key,
      value,
      cite: { ...c, value, quote: `${key}: ${value}` },
    });
  }
  return { facts, files };
}

const defaults = (o: BigEstateOptions) => ({
  repos: o.repos ?? 60,
  entries: o.entries ?? 360,
  calls: o.calls ?? 220,
  tables: o.tables ?? 40,
  settings: o.settings ?? 300,
  seed: o.seed ?? 1,
  gateways: Math.min(o.gateways ?? 0, o.repos ?? 60),
  routes: Math.min(o.routes ?? 40, o.entries ?? 360),
  clusters: o.clusters ?? 1,
});

/** Gateway proxy g's facts: its routes, each forwarding to the deploy token, and the token. */
export function bigGatewayFacts(g: number, o: ReturnType<typeof defaults>): Fact[] {
  const repo = bigGatewayId(g);
  const files: Files = new Map();
  const facts: Fact[] = [];
  const base = { repo, commit: BIG_COMMIT, verified: "line", by: "assistant", conf: "declared" };
  const push = (f: Record<string, unknown>) => facts.push({ ...base, ...f } as unknown as Fact);
  const basePath = basePathOf(g);
  const bp = cited(files, "apiproxy/proxies/default.xml", `<BasePath>${basePath}</BasePath>`);
  const token = "@targetUrl@";
  const te = cited(files, "apiproxy/targets/TE-Service.xml", `<URL>${token}</URL>`);
  for (let k = 0; k < o.routes; k++) {
    const method = METHODS[k % 4]!;
    const suffix = entryPath(g, k, o.clusters);
    const cond = `<Condition>(proxy.pathsuffix MatchesPath "${suffix.replace(/\{id\}/g, "*")}") and (request.verb = "${method}")</Condition>`;
    const c = cited(files, "apiproxy/proxies/default.xml", cond);
    const cite = { ...c, value: suffix.replace(/\{id\}/g, "*"), quote: cond };
    push({
      kind: "entry",
      id: `r-${k}`,
      entryType: "rest",
      method,
      path: basePath + suffix,
      handler: `${repo}/Route${k}`,
      cite: { ...cite, with: [{ file: bp.file, line: bp.line, value: basePath }] },
    });
    push({
      kind: "call",
      id: `f-${k}`,
      callType: "rest",
      method,
      path: suffix,
      host: token,
      from: `r-${k}`,
      cite: { ...cite, with: [{ file: te.file, line: te.line, value: token }] },
    });
  }
  for (const env of ["dv", "qa", "prod"]) {
    const url = `https://${env === "prod" ? "" : `${env}-`}${hostOf(g)}`;
    const e = cited(files, "config.json", `"name": "${env}",`);
    const n = cited(files, "config.json", `"name": "${token}",`);
    const v = cited(files, "config.json", `"value": "${url}"`);
    push({
      kind: "config",
      id: `t-${env}`,
      settingKind: "config",
      key: token,
      value: url,
      env,
      cite: {
        ...v,
        value: url,
        quote: `"value": "${url}"`,
        with: [
          { file: n.file, line: n.line, value: token },
          { file: e.file, line: e.line, value: env },
        ],
      },
    });
  }
  return facts;
}

/** The metarepo (under `dir`), every repo's facts in its snapshot and its working file. */
export async function makeBigEstate(
  dir: string,
  given: BigEstateOptions = {},
): Promise<{ root: string; options: ReturnType<typeof defaults>; repos: string[] }> {
  const o = defaults(given);
  const quiet = { out: () => undefined, err: () => undefined };
  const root = join(dir, "forge");
  if ((await initCommand(root, { name: "forge", platform: "github", owner: "pat" }, quiet)) !== 0)
    throw new Error("atticus init failed");
  const repos = Array.from({ length: o.repos }, (_, r) => bigRepoId(r));
  await writeFile(
    join(root, "org-pack/profiles/github/repos.manifest.yaml"),
    [
      "schemaVersion: 3",
      "platform: github",
      "repos:",
      ...repos.flatMap((id, r) => [
        `  - id: ${id}`,
        `    url: https://git.example.test/forge/${id}.git`,
        "    type: spring-boot",
        "    owner: team-forge",
        `    system: ${id}`,
        `    hosts: [${hostOf(r)}]`,
      ]),
      ...Array.from({ length: o.gateways }, (_, g) => [
        `  - id: ${bigGatewayId(g)}`,
        `    url: https://git.example.test/forge/${bigGatewayId(g)}.git`,
        "    type: gateway",
        "    owner: team-platform",
        "    system: platform",
        `    hosts: [${GATEWAY_HOST}]`,
      ]).flat(),
      "",
    ].join("\n"),
  );
  for (let r = 0; r < o.repos; r++) await writeBigRepo(root, r, o, 0, r < (given.checkouts ?? 2));
  for (let g = 0; g < o.gateways; g++) {
    const facts = bigGatewayFacts(g, o);
    await writeFile(
      join(factsDirOf(root), `${bigGatewayId(g)}.jsonl`),
      facts.map((f) => JSON.stringify(f)).join("\n") + "\n",
    );
    for (const w of factsSnapshotWrites(root, bigGatewayId(g), facts, {
      commit: BIG_COMMIT,
      contracts: null,
    })) {
      await mkdir(dirname(w.path), { recursive: true });
      await writeFile(w.path, w.text!);
    }
  }
  return {
    root,
    options: o,
    repos: [...repos, ...Array.from({ length: o.gateways }, (_, g) => bigGatewayId(g))],
  };
}

/**
 * One repo's facts as of its `edit`-th change: its working facts file and, unless `snapshot` is
 * false, its facts snapshot (as `verify --write` leaves it); its checkout with `checkout`.
 */
export async function writeBigRepo(
  root: string,
  r: number,
  o: ReturnType<typeof defaults>,
  edit: number,
  checkout: boolean,
  snapshot = true,
): Promise<Fact[]> {
  const repo = bigRepoId(r);
  const { facts, files } = bigRepoFacts(r, o, edit);
  const text = facts.map((f) => JSON.stringify(f)).join("\n") + "\n";
  await mkdir(factsDirOf(root), { recursive: true });
  await writeFile(join(factsDirOf(root), `${repo}.jsonl`), text);
  if (snapshot)
    for (const w of factsSnapshotWrites(root, repo, facts, {
      commit: BIG_COMMIT,
      contracts: null,
    })) {
      await mkdir(dirname(w.path), { recursive: true });
      await writeFile(w.path, w.text!);
    }
  if (checkout) {
    const clone = join(root, "workspace", repo);
    for (const [file, lines] of files) {
      const p = join(clone, ...file.split("/"));
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, lines.join("\n") + "\n");
    }
  }
  return facts;
}
