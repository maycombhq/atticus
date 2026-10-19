import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { toCanonicalYaml } from "@maycombhq/core";

/**
 * A synthetic estate for scale tests: many small repos in the style of the Forge fixture
 * (services on the invented Forge framework, Spring Boot BFFs, batch jobs, a gateway, topic
 * configs and infrastructure), wired to call each other. Generation is deterministic for a
 * given seed, and the generator returns the counts a correct scan must find.
 *
 * Nothing here resembles any real estate; names come from fixed word lists.
 */
export interface EstateOptions {
  repos: number;
  seed?: number;
  /** Endpoints per service. */
  endpoints?: number;
  /** Outgoing calls per service. */
  calls?: number;
}

export interface RepoSpec {
  id: string;
  type: "forge-service" | "spring-boot" | "batch-job" | "gateway" | "event-config" | "infra";
  system: string;
  files: Record<string, string>;
}

export interface Estate {
  repos: RepoSpec[];
  /** What a correct scan finds, for asserting results at scale. */
  expected: {
    services: number;
    endpoints: number;
    /** All calls: direct Forge client calls plus Feign calls through the gateway. */
    calls: number;
    /** Calls from Forge services with @ForgeCall (direct). */
    directCalls: number;
    /** Calls from Spring Boot apps and batch jobs with Feign clients (through the gateway). */
    gatewayCalls: number;
    topics: number;
    migrations: number;
    deployments: number;
  };
  manifest: string;
}

/** Small deterministic PRNG (mulberry32), so the same seed gives the same estate everywhere. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOUNS = [
  "ledger",
  "account",
  "payment",
  "invoice",
  "card",
  "loan",
  "rate",
  "fee",
  "statement",
  "limit",
  "alert",
  "profile",
  "consent",
  "document",
  "branch",
  "deposit",
  "transfer",
  "hold",
  "fx",
  "tax",
];
const ROLES = ["api", "engine", "store", "router", "hub", "registry", "worker", "view"];

function pad(n: number, w = 3) {
  return String(n).padStart(w, "0");
}

export function generateEstate(o: EstateOptions): Estate {
  const rnd = prng(o.seed ?? 42);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const nEndpoints = o.endpoints ?? 4;
  const nCalls = o.calls ?? 2;

  // Share out repo kinds: mostly services, some BFFs and jobs, then the shared repos.
  const shared = 3; // gateway, events, infra
  const work = Math.max(1, o.repos - shared);
  const kinds: RepoSpec["type"][] = [];
  for (let i = 0; i < work; i++)
    kinds.push(i % 10 < 6 ? "forge-service" : i % 10 < 8 ? "spring-boot" : "batch-job");

  const services: {
    id: string;
    system: string;
    endpoints: { method: string; path: string; name: string }[];
  }[] = [];
  const repos: RepoSpec[] = [];
  const topics = new Set<string>();
  let calls = 0;
  let migrations = 0;

  kinds.forEach((kind, i) => {
    const noun = NOUNS[i % NOUNS.length]!;
    const id = `syn-${noun}-${pick(ROLES)}-${pad(i)}`;
    const system = `sys-${noun}`;
    const files: Record<string, string> = {};
    const pkg = `synth.s${pad(i)}`;
    if (kind === "forge-service") {
      const eps = Array.from({ length: nEndpoints }, (_, k) => ({
        method: k % 2 ? "POST" : "GET",
        path: `/${noun}s/v${1 + (k % 3)}/item${k}`,
        name: `op${k}`,
      }));
      services.push({ id, system, endpoints: eps });
      files["forge.yaml"] = `service: ${id}\nsystem: ${system}\nframework: forge\n`;
      files[`src/main/java/${pkg.replace(/\./g, "/")}/Endpoints.java`] = [
        `package ${pkg};`,
        "",
        "import forge.framework.*;",
        "",
        `@ForgeService(name = "${id}")`,
        "public class Endpoints {",
        ...eps.flatMap((e) => [
          `  @ForgeEndpoint(method = "${e.method}", path = "${e.path}", auth = "oauth2")`,
          `  public Object ${e.name}() { return null; }`,
          "",
        ]),
        "}",
        "",
      ].join("\n");
      const topic = `${noun}.changed.${pad(i)}`;
      topics.add(topic);
      files[`src/main/java/${pkg.replace(/\./g, "/")}/Events.java`] = [
        `package ${pkg};`,
        "",
        "import forge.framework.*;",
        "",
        "public class Events {",
        `  @ForgePublish(topic = "${topic}")`,
        "  public Object changed(Object o) { return o; }",
        "}",
        "",
      ].join("\n");
      files["src/main/resources/db/migration/V1__init.sql"] =
        `create table ${noun}_${pad(i)} (id varchar(36) primary key, created_at timestamp not null);\n`;
      migrations++;
    } else {
      files["pom.xml"] = `<project><artifactId>${id}</artifactId></project>\n`;
      files["src/main/resources/application.yml"] = `spring:\n  application:\n    name: ${id}\n`;
    }
    repos.push({ id, type: kind, system, files });
  });

  // Wire calls: every non-shared repo calls a few services that come before it, so the
  // graph is acyclic and the expected count is exact. Forge services call directly with
  // @ForgeClient; Spring Boot apps and batch jobs call through the gateway with Feign.
  let directCalls = 0;
  let gatewayCalls = 0;
  repos.forEach((r, i) => {
    const targets = services.filter((s) => s.id !== r.id).slice(0, Math.min(nCalls, i));
    if (targets.length === 0) return;
    const pkg = `synth.s${pad(i)}`;
    const dir = `src/main/java/${pkg.replace(/\./g, "/")}`;
    if (r.type === "forge-service") {
      const lines = [`package ${pkg};`, "", "import forge.framework.*;", ""];
      targets.forEach((t, k) => {
        const ep = t.endpoints[k % t.endpoints.length]!;
        lines.push(
          `@ForgeClient(service = "${t.id}", baseUrl = "\${${t.id}.url}")`,
          `interface Client${k} {`,
          `  @ForgeCall(method = "${ep.method}", path = "${ep.path}")`,
          `  Object call${k}();`,
          "}",
          "",
        );
        directCalls++;
      });
      r.files[`${dir}/Clients.java`] = lines.join("\n");
    } else {
      targets.forEach((t, k) => {
        const ep = t.endpoints[k % t.endpoints.length]!;
        r.files[`${dir}/Client${k}.java`] = [
          `package ${pkg};`,
          "",
          "import org.springframework.cloud.openfeign.FeignClient;",
          "import org.springframework.web.bind.annotation.*;",
          "",
          `@FeignClient(name = "${t.id}", url = "\${gateway.url}/${t.id}")`,
          `public interface Client${k} {`,
          `  @${ep.method === "GET" ? "Get" : "Post"}Mapping("${ep.path}")`,
          `  Object call${k}();`,
          "}",
          "",
        ].join("\n");
        gatewayCalls++;
      });
      r.files["src/main/resources/application.yml"] +=
        "gateway:\n  url: https://gateway.synth.example\n";
    }
    calls += targets.length;
  });

  // Shared repos.
  repos.push({
    id: "syn-gateway",
    type: "gateway",
    system: "sys-gateway",
    files: Object.fromEntries(
      services.flatMap((s) => [
        [
          `proxies/${s.id}/apiproxy/proxies/default.xml`,
          `<ProxyEndpoint name="default">\n  <HTTPProxyConnection>\n    <BasePath>/${s.id}</BasePath>\n  </HTTPProxyConnection>\n  <RouteRule name="default">\n    <TargetEndpoint>default</TargetEndpoint>\n  </RouteRule>\n</ProxyEndpoint>\n`,
        ],
        [
          `proxies/${s.id}/apiproxy/targets/default.xml`,
          `<TargetEndpoint name="default">\n  <HTTPTargetConnection>\n    <URL>http://${s.id}.synth.internal</URL>\n  </HTTPTargetConnection>\n</TargetEndpoint>\n`,
        ],
      ]),
    ),
  });
  repos.push({
    id: "syn-events",
    type: "event-config",
    system: "sys-events",
    files: Object.fromEntries(
      [...topics].sort().map((t) => [`topics/${t}.yaml`, `name: ${t}\npartitions: 3\n`]),
    ),
  });
  const deployed = repos.filter(
    (r) => r.type === "forge-service" || r.type === "spring-boot" || r.type === "batch-job",
  );
  repos.push({
    id: "syn-infra",
    type: "infra",
    system: "sys-platform",
    files: Object.fromEntries(
      deployed.map((r) => [
        `k8s/${r.id}.yaml`,
        `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${r.id}\nspec:\n  replicas: 2\n`,
      ]),
    ),
  });

  const manifest = toCanonicalYaml(
    {
      schemaVersion: 1,
      platform: "synth",
      repos: repos.map((r) => ({
        id: r.id,
        url: `https://git.example.com/synth/${r.id}.git`,
        defaultBranch: "main",
        type: r.type,
        owner: `team-${r.system.replace(/^sys-/, "")}`,
        system: r.system,
        extractors: [],
        dialects: r.type === "forge-service" ? ["forge"] : [],
        sparse: [],
        archived: false,
        // The gateway's host, so calls to it go through its routes (ADR 0053).
        hosts: r.type === "gateway" ? ["gateway.synth.example"] : [],
      })),
    },
    ["schemaVersion", "platform", "id"],
  );

  return {
    repos,
    manifest,
    expected: {
      services: services.length,
      endpoints: services.length * nEndpoints,
      calls,
      directCalls,
      gatewayCalls,
      topics: topics.size,
      migrations,
      deployments: deployed.length,
    },
  };
}

/** Write the estate to disk: one folder per repo under `dir`, plus repos.manifest.yaml. */
export async function writeEstate(estate: Estate, dir: string): Promise<void> {
  for (const r of estate.repos) {
    for (const [path, text] of Object.entries(r.files)) {
      const full = join(dir, "repos", r.id, ...path.split("/"));
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, text, "utf8");
    }
  }
  await mkdir(join(dir, "org-pack", "profiles", "synth"), { recursive: true });
  await writeFile(
    join(dir, "org-pack", "profiles", "synth", "repos.manifest.yaml"),
    estate.manifest,
    "utf8",
  );
}
