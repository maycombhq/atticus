import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { stringify } from "yaml";

/**
 * Small invented estates for the property tests of ADR 0195 (ticket CS4): 2 to 5 Forge repos,
 * each a Spring service with endpoints, calls into the others' endpoints by host, and topics it
 * publishes or listens to. Everything is invented (CLAUDE.md rule 3) and written to temporary
 * folders as files and local git commits (rule 5: no network).
 */

/** One repo of the pool: its names, what it may serve, and the topic it may publish. */
export interface Base {
  /** The repo id before any rename. */
  id: string;
  short: string;
  component: string;
  system: string;
  host: string;
  /** A host no repo lists until a person answers which repo answers on it (ADR 0088). */
  legacyHost: string;
  cls: string;
  endpoints: Ep[];
  topic: string;
}

export interface Ep {
  method: "GET" | "POST";
  path: string;
}

export interface Call extends Ep {
  host: string;
}

/** What a repo's code holds at one commit. */
export interface Code {
  endpoints: Ep[];
  calls: Call[];
  publishes: string[];
  consumes: string[];
}

export interface Estate {
  /** The pool entries, in slot order: a repo is known by its slot, so a rename keeps it. */
  repos: { base: Base; code: Code }[];
}

const base = (short: string, cls: string, paths: [string, string, string]): Base => ({
  id: `forge-${short}`,
  short,
  component: `${short}-api`,
  system: short,
  host: `${short}.forge.example`,
  legacyHost: `legacy-${short}.forge.example`,
  cls,
  endpoints: [
    { method: "GET", path: paths[0] },
    { method: "POST", path: paths[1] },
    { method: "GET", path: paths[2] },
  ],
  topic: `forge.${short}.changed`,
});

export const POOL: readonly Base[] = [
  base("ledger", "Ledger", ["/accounts", "/entries", "/balances"]),
  base("payments", "Payments", ["/payments", "/refunds", "/payouts"]),
  base("orders", "Orders", ["/orders", "/carts", "/returns"]),
  base("notify", "Notify", ["/notices", "/templates", "/channels"]),
  base("customers", "Customers", ["/customers", "/addresses", "/consents"]),
];

/**
 * A repo's code as the generators make it, by position rather than by name, so it can be
 * generated before the estate it lands in and still shrink on its own: endpoints by their place
 * in the repo's pool entry, calls by which other repo (an index into the others, modulo their
 * count) and which of its endpoints, topics by whether it publishes its own and which other
 * repo's it listens to. `resolve` turns it into the repo's `Code`.
 */
export interface Sketch {
  endpoints: number[];
  calls: { to: number; ep: number; legacy: boolean }[];
  publishes: boolean;
  consumes: number[];
}

export const sketchArb: fc.Arbitrary<Sketch> = fc.record({
  endpoints: fc.uniqueArray(fc.nat({ max: 2 }), { maxLength: 2 }),
  calls: fc.array(
    fc.record({
      to: fc.nat({ max: 3 }),
      ep: fc.nat({ max: 2 }),
      // A call to a host no repo lists is rarer: a person answers which repo it is.
      legacy: fc.boolean().chain((b) => (b ? fc.boolean() : fc.constant(false))),
    }),
    { maxLength: 2 },
  ),
  publishes: fc.boolean(),
  consumes: fc.uniqueArray(fc.nat({ max: 3 }), { maxLength: 1 }),
});

/** The code a sketch stands for, for the repo in `slot` of an estate of these pool entries. */
export function resolve(bases: readonly Base[], slot: number, k: Sketch): Code {
  const me = bases[slot]!;
  const others = bases.filter((_, i) => i !== slot);
  const uniq = <T>(xs: T[]) => [...new Map(xs.map((x) => [JSON.stringify(x), x])).values()];
  return {
    endpoints: uniq(k.endpoints.map((i) => me.endpoints[i % me.endpoints.length]!)),
    calls: others.length
      ? uniq(
          k.calls.map((c) => {
            const o = others[c.to % others.length]!;
            return {
              ...o.endpoints[c.ep % o.endpoints.length]!,
              host: c.legacy ? o.legacyHost : o.host,
            };
          }),
        )
      : [],
    publishes: k.publishes ? [me.topic] : [],
    consumes: others.length ? uniq(k.consumes.map((i) => others[i % others.length]!.topic)) : [],
  };
}

/**
 * An estate of 2 to 5 repos of the pool with their first code. Made without `chain`, so a
 * failure shrinks the estate (to two repos, to less code) and the commands on their own.
 */
export const estateArb: fc.Arbitrary<Estate> = fc
  .tuple(
    fc.uniqueArray(fc.nat({ max: POOL.length - 1 }), { minLength: 2, maxLength: 5 }),
    fc.array(sketchArb, { minLength: 5, maxLength: 5 }),
  )
  .map(([picks, sketches]) => {
    const bases = picks.map((i) => POOL[i]!);
    return { repos: bases.map((b, i) => ({ base: b, code: resolve(bases, i, sketches[i]!) })) };
  });

/** A file of a repo, as lines, with where each thing it holds was written. */
interface Rendered {
  files: Map<string, string>;
  /** Per thing (`entry GET /x`, `call GET host/x`, `publish t`, `consume t`), its file, line and line text. */
  at: Map<string, { file: string; line: number; text: string }>;
}

const key = {
  entry: (e: Ep) => `entry ${e.method} ${e.path}`,
  call: (c: Call) => `call ${c.method} ${c.host}${c.path}`,
  publish: (t: string) => `publish ${t}`,
  consume: (t: string) => `consume ${t}`,
};

/** The repo's Java files for its code: one controller, client, publisher and listener. */
export function renderCode(b: Base, code: Code): Rendered {
  const files = new Map<string, string>();
  const at = new Map<string, { file: string; line: number; text: string }>();
  const dir = `src/main/java/forge/${b.short}`;
  const file = (name: string, lines: string[], marks: [string, number][]) => {
    const path = `${dir}/${name}`;
    files.set(path, lines.join("\n") + "\n");
    for (const [k, i] of marks) at.set(k, { file: path, line: i + 1, text: lines[i]!.trim() });
  };
  files.set("README.md", `# ${b.id}\n\nThe invented ${b.cls} service of the Forge estate.\n`);
  files.set("pom.xml", `<project><artifactId>${b.id}</artifactId></project>\n`);
  if (code.endpoints.length) {
    const lines = [
      `package forge.${b.short};`,
      "",
      "import org.springframework.web.bind.annotation.*;",
      "",
      "@RestController",
      `public class ${b.cls}Controller {`,
    ];
    const marks: [string, number][] = [];
    code.endpoints.forEach((e, i) => {
      marks.push([key.entry(e), lines.length]);
      lines.push(`  @${e.method === "GET" ? "Get" : "Post"}Mapping("${e.path}")`);
      lines.push(`  public String handle${i}() { return "ok"; }`, "");
    });
    lines.push("}");
    file(`${b.cls}Controller.java`, lines, marks);
  }
  if (code.calls.length) {
    const lines = [
      `package forge.${b.short};`,
      "",
      "import org.springframework.web.client.RestTemplate;",
      "",
      `public class ${b.cls}Client {`,
      "  private final RestTemplate rest = new RestTemplate();",
      "",
    ];
    const marks: [string, number][] = [];
    code.calls.forEach((c, i) => {
      lines.push(`  public String call${i}(String body) {`);
      marks.push([key.call(c), lines.length]);
      lines.push(
        c.method === "GET"
          ? `    return rest.getForObject("http://${c.host}${c.path}", String.class);`
          : `    return rest.postForObject("http://${c.host}${c.path}", body, String.class);`,
      );
      lines.push("  }", "");
    });
    lines.push("}");
    file(`${b.cls}Client.java`, lines, marks);
  }
  if (code.publishes.length) {
    const lines = [
      `package forge.${b.short};`,
      "",
      "import org.springframework.kafka.core.KafkaTemplate;",
      "",
      `public class ${b.cls}Events {`,
      "  private KafkaTemplate<String, String> kafka;",
      "",
    ];
    const marks: [string, number][] = [];
    code.publishes.forEach((t, i) => {
      lines.push(`  public void publish${i}(String event) {`);
      marks.push([key.publish(t), lines.length]);
      lines.push(`    kafka.send("${t}", event);`, "  }", "");
    });
    lines.push("}");
    file(`${b.cls}Events.java`, lines, marks);
  }
  if (code.consumes.length) {
    const lines = [
      `package forge.${b.short};`,
      "",
      "import org.springframework.kafka.annotation.KafkaListener;",
      "import org.springframework.stereotype.Component;",
      "",
      "@Component",
      `public class ${b.cls}Listener {`,
    ];
    const marks: [string, number][] = [];
    code.consumes.forEach((t, i) => {
      marks.push([key.consume(t), lines.length]);
      lines.push(`  @KafkaListener(topics = "${t}")`);
      lines.push(`  public void on${i}(String payload) {`, "  }", "");
    });
    lines.push("}");
    file(`${b.cls}Listener.java`, lines, marks);
  }
  return { files, at };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * The facts the assistant writes for a repo's code at a commit (ADR 0124): one per entry, call
 * and topic, each citing its line. `broken` cites one fact on the wrong line, so the verifier
 * rejects it and `verify --write` refuses.
 */
export function renderFacts(
  b: Base,
  repo: string,
  code: Code,
  commit: string,
  o: { broken?: boolean } = {},
): string {
  const { at } = renderCode(b, code);
  const cite = (k: string, value: string) => {
    const a = at.get(k)!;
    return { file: a.file, line: a.line, value, quote: a.text };
  };
  const common = { repo, commit, component: b.component };
  const tail = { verified: "none", by: "assistant", conf: "declared" };
  const facts: Record<string, unknown>[] = [];
  for (const e of code.endpoints)
    facts.push({
      kind: "entry",
      id: `e-${slug(`${e.method} ${e.path}`)}`,
      ...common,
      entryType: "rest",
      method: e.method,
      path: e.path,
      cite: cite(key.entry(e), e.path),
      ...tail,
    });
  for (const t of code.consumes)
    facts.push({
      kind: "entry",
      id: `e-on-${slug(t)}`,
      ...common,
      entryType: "event-topic",
      path: t,
      cite: cite(key.consume(t), t),
      ...tail,
    });
  for (const c of code.calls)
    facts.push({
      kind: "call",
      id: `c-${slug(`${c.method} ${c.host} ${c.path}`)}`,
      ...common,
      callType: "rest",
      method: c.method,
      path: c.path,
      host: c.host,
      sync: "sync",
      cite: cite(key.call(c), c.path),
      ...tail,
    });
  for (const t of code.publishes)
    facts.push({
      kind: "call",
      id: `c-publish-${slug(t)}`,
      ...common,
      callType: "event-topic",
      path: t,
      sync: "async",
      cite: cite(key.publish(t), t),
      ...tail,
    });
  if (o.broken) {
    // A fact the code doesn't hold: its cite names line 1 (the package line), so it is rejected.
    facts.push({
      kind: "entry",
      id: "e-get-not-there",
      ...common,
      entryType: "rest",
      method: "GET",
      path: "/not-there",
      cite: { file: "README.md", line: 1, value: "/not-there", quote: `# ${b.id}` },
      ...tail,
    });
  }
  return facts.map((f) => JSON.stringify(f)).join("\n") + (facts.length ? "\n" : "");
}

/** A fixed author, committer and date, so the same history gives the same commits. */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Forge Dev",
  GIT_AUTHOR_EMAIL: "dev@forge.example",
  GIT_COMMITTER_NAME: "Forge Dev",
  GIT_COMMITTER_EMAIL: "dev@forge.example",
  GIT_AUTHOR_DATE: "2026-11-01T09:00:00Z",
  GIT_COMMITTER_DATE: "2026-11-01T09:00:00Z",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "init.defaultBranch",
  GIT_CONFIG_VALUE_0: "main",
  GIT_CONFIG_KEY_1: "core.autocrlf",
  GIT_CONFIG_VALUE_1: "false",
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: GIT_ENV,
  }).trim();
}

/** Put the repo's files for `code` in its clone and commit them; the new commit. */
export async function commitCode(dir: string, b: Base, code: Code, n: number): Promise<string> {
  if (n === 0) {
    // A repo's first commit depends only on its pool entry and code (the dates are fixed), so
    // it is made once per run and copied: a property run starts hundreds of estates.
    const key = `${b.id}\u0000${JSON.stringify(code)}`;
    let first = firstCommits.get(key);
    if (!first) {
      const made = join(await firstCommitsDir(), String(firstCommits.size));
      first = commitFresh(made, b, code).then((commit) => ({ dir: made, commit }));
      firstCommits.set(key, first);
    }
    const { dir: from, commit } = await first;
    await cp(from, dir, { recursive: true });
    return commit;
  }
  return commitFresh(dir, b, code, n);
}

const firstCommits = new Map<string, Promise<{ dir: string; commit: string }>>();
let firstDir: Promise<string> | undefined;
const firstCommitsDir = () => (firstDir ??= mkdtemp(join(tmpdir(), "cs4-first-")));

async function commitFresh(dir: string, b: Base, code: Code, n = 0): Promise<string> {
  await mkdir(dir, { recursive: true });
  for (const e of await readdir(dir).catch(() => [] as string[]))
    if (e !== ".git") await rm(join(dir, e), { recursive: true, force: true });
  for (const [rel, text] of renderCode(b, code).files) {
    const full = join(dir, ...rel.split("/"));
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text);
  }
  if (n === 0) git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", `change ${n}`);
  // Read from the ref file rather than one more git process: a property run makes hundreds.
  const ref = await readFile(join(dir, ".git", "refs", "heads", "main"), "utf8").catch(() => "");
  return ref.trim() || git(dir, "rev-parse", "HEAD");
}

/** A repo of the manifest as the org pack lists it. */
export interface ManifestRepo {
  id: string;
  base: Base;
  hosts: string[];
  archived: boolean;
}

/** The org pack: the Forge profile with a system per repo, and the manifest. */
export async function writeOrgPack(root: string, repos: readonly ManifestRepo[]): Promise<void> {
  const op = join(root, "org-pack");
  await mkdir(join(op, "profiles", "forge"), { recursive: true });
  await writeFile(
    join(op, "pack.yaml"),
    "schemaVersion: 1\nname: forge\nversion: 0.1.0\nowner: team-platform\n",
  );
  // Every pool system stays in the profile, so a repo removed from the manifest is still a
  // system the profile names (a person removes the repo, not the system).
  await writeFile(
    join(op, "profiles", "forge", "profile.yaml"),
    stringify({
      schemaVersion: 1,
      platform: "forge",
      name: "Forge (invented, for the catalog property tests of ADR 0195)",
      systems: POOL.map((b) => ({
        id: b.system,
        name: b.cls,
        boundary: "product",
        owner: `team-${b.short}`,
        aliases: [],
      })),
      environments: ["dev", "prod"],
    }),
  );
  await writeManifest(root, repos);
}

export async function writeManifest(root: string, repos: readonly ManifestRepo[]): Promise<void> {
  await writeFile(
    join(root, "org-pack", "profiles", "forge", "repos.manifest.yaml"),
    stringify({
      schemaVersion: 1,
      platform: "forge",
      repos: repos.map((r) => ({
        id: r.id,
        url: `https://git.forge.example/forge/${r.base.id}.git`,
        type: "spring-boot",
        owner: `team-${r.base.short}`,
        component: r.base.component,
        system: r.base.system,
        hosts: r.hosts,
        ...(r.archived ? { archived: true } : {}),
      })),
    }),
  );
}
