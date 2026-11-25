import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import fc from "fast-check";
import { stringify } from "yaml";

/**
 * Small invented estates for the property tests of ADR 0195 (ticket CS4): 2 to 4 Forge repos,
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
  /**
   * The target the assistant names for the call (a fact's `to`), when the examples give one: the
   * join takes a target it doesn't know for one outside the estate (beta.27.2, the review).
   */
  to?: string;
}

/** What a repo's code holds at one commit. */
export interface Code {
  endpoints: Ep[];
  calls: Call[];
  publishes: string[];
  consumes: string[];
  /**
   * How many more endpoints it serves that nothing calls and no command changes (its admin
   * routes): a repo with records enough that one removal is under the 10% limit of ADR 0195
   * point 4, so small explained removals are written, not only confirmed. 0 when absent.
   */
  filler?: number;
  /**
   * A source file no fact cites and nothing marks reviewed (the examples' read in parts): verify
   * then says the read isn't complete, and its facts slot doesn't say `readComplete`.
   */
  unread?: true;
}

/** Every endpoint a repo's code serves: its own, then its filler routes. */
export function served(b: Base, code: Code): Ep[] {
  const filler = Array.from({ length: code.filler ?? 0 }, (_, i): Ep => ({
    method: "GET",
    path: `/${b.short}-admin/r${i}`,
  }));
  return [...code.endpoints, ...filler];
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
      // A call to a host no repo lists, which a person answers (one in three).
      legacy: fc.oneof(
        { arbitrary: fc.constant(false), weight: 2 },
        { arbitrary: fc.constant(true), weight: 1 },
      ),
    }),
    { maxLength: 2 },
  ),
  publishes: fc.boolean(),
  consumes: fc.uniqueArray(fc.nat({ max: 3 }), { maxLength: 1 }),
});

/** The code a sketch stands for, for the repo in `slot` of an estate of these pool entries. */
export function resolve(bases: readonly Base[], slot: number, k: Sketch, filler = 0): Code {
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
    ...(filler ? { filler } : {}),
  };
}

/** The filler routes of a bulky estate's repos: one removal is then under the 10% limit. */
export const BULK = 10;

/**
 * An estate of 2 to 4 repos of the pool with their first code, small (a repo has a handful of
 * records, so a removal is nearly always above the 10% limit) or bulky (each repo serves BULK
 * more routes, so one or two removals are under it). Made without `chain`, so a failure shrinks
 * the estate (to small, to two repos, to less code) and the commands on their own.
 */
export const estateArb: fc.Arbitrary<Estate> = fc
  .tuple(
    fc.uniqueArray(fc.nat({ max: POOL.length - 1 }), { minLength: 2, maxLength: 4 }),
    fc.array(sketchArb, { minLength: 5, maxLength: 5 }),
    fc.oneof({ withCrossShrink: true }, fc.constant(0), fc.constant(BULK)),
  )
  .map(([picks, sketches, filler]) => {
    const bases = picks.map((i) => POOL[i]!);
    return {
      repos: bases.map((b, i) => ({ base: b, code: resolve(bases, i, sketches[i]!, filler) })),
    };
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
  const eps = served(b, code);
  if (eps.length) {
    const lines = [
      `package forge.${b.short};`,
      "",
      "import org.springframework.web.bind.annotation.*;",
      "",
      "@RestController",
      `public class ${b.cls}Controller {`,
    ];
    const marks: [string, number][] = [];
    eps.forEach((e, i) => {
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
  if (code.unread)
    file(
      `${b.cls}Jobs.java`,
      [`package forge.${b.short};`, "", `public class ${b.cls}Jobs {}`],
      [],
    );
  return { files, at };
}

export const slugOf = (s: string) => slug(s);
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * What the assistant writes for a repo's read under `<root>/facts/`: its facts, and pom.xml
 * marked reviewed with nothing to record, so the read is complete (verify says so, and its facts
 * slot's meta says `readComplete`) unless the code has a file no fact cites (`Code.unread`).
 */
export async function writeRead(
  root: string,
  b: Base,
  repo: string,
  code: Code,
  commit: string,
  o: { broken?: boolean; later?: number } = {},
): Promise<void> {
  await mkdir(join(root, "facts"), { recursive: true });
  await writeFile(join(root, "facts", `${repo}.jsonl`), renderFacts(b, repo, code, commit, o));
  await writeFile(
    join(root, "facts", `${repo}.reviewed.jsonl`),
    `${JSON.stringify({ path: "pom.xml", why: "The build file names the artifact only." })}\n`,
  );
}

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
  o: { broken?: boolean; later?: number } = {},
): string {
  const { at } = renderCode(b, code);
  const cite = (k: string, value: string) => {
    const a = at.get(k)!;
    return { file: a.file, line: a.line, value, quote: a.text };
  };
  const common = { repo, commit, component: b.component };
  const tail = { verified: "none", by: "assistant", conf: "declared" };
  const facts: Record<string, unknown>[] = [];
  for (const e of served(b, code))
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
      ...(c.to ? { to: c.to } : {}),
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
  if (o.later !== undefined && facts.length) {
    // An accepted fact read again on a line that doesn't say it (the README's first): rejected.
    const i = o.later % facts.length;
    const f = facts[i]!;
    const v = (f.cite as { value: string }).value;
    facts[i] = { ...f, cite: { file: "README.md", line: 1, value: v, quote: `# ${b.id}` } };
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
  GIT_CONFIG_COUNT: "4",
  GIT_CONFIG_KEY_0: "init.defaultBranch",
  GIT_CONFIG_VALUE_0: "main",
  GIT_CONFIG_KEY_1: "core.autocrlf",
  GIT_CONFIG_VALUE_1: "false",
  // A property run makes hundreds of commits in throwaway clones (ADR 0195, CS4's budget): no
  // commit starts git's housekeeping, a process of its own each time, on a clone gone in seconds.
  GIT_CONFIG_KEY_2: "maintenance.auto",
  GIT_CONFIG_VALUE_2: "false",
  GIT_CONFIG_KEY_3: "gc.auto",
  GIT_CONFIG_VALUE_3: "0",
};

/** git found once on PATH (each call would otherwise look it up again in every PATH folder). */
const GIT = (() => {
  if (process.platform === "win32") return "git";
  for (const d of (process.env.PATH ?? "").split(delimiter))
    try {
      const p = join(d, "git");
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // not in this folder
    }
  return "git";
})();

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(GIT, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: GIT_ENV,
  }).trim();
}

/**
 * Several git commands in order, stopping at the first that fails: one shell running them where
 * there is one, so the test's process (large, by the end of a run) starts one process, not one
 * per command (ADR 0195, CS4's budget: a run makes hundreds of commits).
 */
function gitSteps(cwd: string, steps: readonly (readonly string[])[]): void {
  if (process.platform === "win32" || steps.length === 1) {
    for (const s of steps) git(cwd, ...s);
    return;
  }
  const q = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;
  const script = steps.map((s) => `"$ATTICUS_GIT" ${s.map(q).join(" ")}`).join(" && ");
  execFileSync("/bin/sh", ["-c", script], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...GIT_ENV, ATTICUS_GIT: GIT },
  });
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

/** Remove the first commits made for this run (the test file's afterAll). */
export async function disposeFirstCommits(): Promise<void> {
  const dir = firstDir && (await firstDir);
  firstDir = undefined;
  firstCommits.clear();
  committed.clear();
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** The files each clone's last commit here holds, by folder: a commit of the same files needs no `git add`. */
const committed = new Map<string, string>();

async function commitFresh(dir: string, b: Base, code: Code, n = 0): Promise<string> {
  const files = renderCode(b, code).files;
  const names = [...files.keys()].sort().join("\n");
  // The same set of files as the last commit: write them over and `commit -a`, one git process
  // instead of two (a property run makes hundreds of commits, and a process costs more than git).
  const same = n > 0 && committed.get(dir) === names;
  await mkdir(dir, { recursive: true });
  if (!same)
    for (const e of await readdir(dir).catch(() => [] as string[]))
      if (e !== ".git") await rm(join(dir, e), { recursive: true, force: true });
  for (const [rel, text] of files) {
    const full = join(dir, ...rel.split("/"));
    if (!same) await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text);
  }
  const message = `change ${n}`;
  gitSteps(dir, [
    ...(n === 0 ? [["init", "-q"]] : []),
    ...(same
      ? [["commit", "-q", "-a", "--allow-empty", "-m", message]]
      : [
          ["add", "-A"],
          ["commit", "-q", "--allow-empty", "-m", message],
        ]),
  ]);
  committed.set(dir, names);
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
  // ADR 0210 part 6: the model's scans are the readers', so this pack turns them on.
  await writeFile(join(op, "conventions.yaml"), 'schemaVersion: 3\nreaders: "on"\n');
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

// ------------------------------------------------------------------ estate shapes (beta.30)

/**
 * Beta.30 (slice 9, field-reliability-and-ease.md item 2): the shapes field reports named, as a
 * generator. The estates above vary the catalog's states over tidy repos; these vary the estate's
 * shape: hosts written as deploy tokens (`@name@`, `${NAME}`) nothing sets, a repo id with dots, a
 * repo the manifest gives no System, a gateway proxy fronting a service (its target URL a token
 * its deploy file sets per environment), and nested payload fields. Each repo is read from facts
 * (the assistant's, with their snapshots, as `verify --write` leaves them); no clone, no network.
 * Every repo's calls share ids (`c-0`, `c-1`, …), as assistants name them in the field; each loose
 * end is still a record of its own, its id carrying its repo (ADR 0124 addendum E-ids).
 */
export interface ShapeSketch {
  /** How many services, 2 to 4, from the pool. */
  services: number;
  /** The first service's id has dots (`forge.ledger.svc`). */
  dotted: boolean;
  /** The last service's manifest entry names no System. */
  noSystem: boolean;
  /** A gateway proxy fronts the first service; its target URL as `@targetUrl@` or `${TARGET_URL}`. */
  proxy: "none" | "at" | "dollar";
  /** The second service's entries have nested payload fields. */
  nested: boolean;
  /**
   * Each service's calls, by position: to which other service (an index into the others, modulo
   * their count), which of its endpoints, and how: by its host, through the proxy (to the first
   * service; by host when there is none), to a host token nothing sets, or to the outside vendor.
   */
  calls: { from: number; to: number; ep: number; via: "host" | "proxy" | "token" | "outside" }[];
  /** How a host token nothing sets is written. */
  token: "at" | "dollar";
}

export const shapeArb: fc.Arbitrary<ShapeSketch> = fc.record({
  services: fc.integer({ min: 2, max: 4 }),
  dotted: fc.boolean(),
  noSystem: fc.boolean(),
  proxy: fc.constantFrom("none", "at", "dollar"),
  nested: fc.boolean(),
  calls: fc.array(
    fc.record({
      from: fc.nat({ max: 3 }),
      to: fc.nat({ max: 2 }),
      ep: fc.nat({ max: 2 }),
      via: fc.constantFrom("host", "proxy", "token", "outside"),
    }),
    { maxLength: 8 },
  ),
  token: fc.constantFrom("at", "dollar"),
});

/** A call fact of a shaped estate, as the oracle reads it back. */
export interface ShapedCall {
  repo: string;
  fact: string;
  file: string;
  line: number;
  via: ShapeSketch["calls"][number]["via"] | "forward";
  /** The host the call is written to. */
  host: string;
  /** The component its arrow goes to, for a call by a listed host or a gateway's forward. */
  to?: string;
}

export interface ShapedEstate {
  /** Every repo the manifest lists, read from facts. */
  repos: string[];
  calls: ShapedCall[];
}

const SHAPE_COMMIT = "5ba9e00";
const GATEWAY_HOST = "gw.forge.example";

/** A shaped estate under `root`: the org pack, every repo's facts and their snapshots. */
export async function writeShapeEstate(
  root: string,
  k: ShapeSketch,
  snapshot: (
    root: string,
    repo: string,
    facts: Record<string, unknown>[],
    commit: string,
  ) => Promise<void>,
): Promise<ShapedEstate> {
  const bases = POOL.slice(0, k.services);
  const idOf = (i: number) => (i === 0 && k.dotted ? `forge.${bases[0]!.short}.svc` : bases[i]!.id);
  const gw = k.proxy === "none" ? undefined : `forge-${bases[0]!.short}-gw`;
  const basePath = `/${bases[0]!.short}/1.0`;
  const op = join(root, "org-pack");
  await mkdir(join(op, "profiles", "forge"), { recursive: true });
  await writeFile(
    join(op, "pack.yaml"),
    "schemaVersion: 1\nname: forge\nversion: 0.1.0\nowner: team-platform\n",
  );
  await writeFile(
    join(op, "profiles", "forge", "profile.yaml"),
    stringify({
      schemaVersion: 1,
      platform: "forge",
      name: "Forge (invented, for the shape property tests of beta.30)",
      systems: [
        ...POOL.map((b) => ({
          id: b.system,
          name: b.cls,
          boundary: "product",
          owner: `team-${b.short}`,
          aliases: [],
        })),
        {
          id: "platform",
          name: "Platform",
          boundary: "product",
          owner: "team-platform",
          aliases: [],
        },
      ],
      environments: ["dev", "prod"],
    }),
  );
  await writeFile(
    join(op, "profiles", "forge", "repos.manifest.yaml"),
    stringify({
      schemaVersion: 1,
      platform: "forge",
      repos: [
        ...bases.map((b, i) => ({
          id: idOf(i),
          url: `https://git.forge.example/forge/${idOf(i)}.git`,
          type: "spring-boot",
          owner: `team-${b.short}`,
          component: b.component,
          ...(k.noSystem && i === bases.length - 1 && i > 0 ? {} : { system: b.system }),
          hosts: [b.host],
        })),
        ...(gw
          ? [
              {
                id: gw,
                url: `git@git.forge.example:forge/${gw}.git`,
                type: "gateway",
                owner: "team-platform",
                system: "platform",
                hosts: [GATEWAY_HOST],
              },
            ]
          : []),
      ],
    }),
  );
  const calls: ShapedCall[] = [];
  const tail = { commit: SHAPE_COMMIT, verified: "line", by: "assistant", conf: "declared" };
  for (const [i, b] of bases.entries()) {
    const repo = idOf(i);
    const file = `src/main/java/forge/${b.short}/${b.cls}Controller.java`;
    const client = `src/main/java/forge/${b.short}/${b.cls}Client.java`;
    const facts: Record<string, unknown>[] = [];
    let line = 0;
    for (const [n, e] of b.endpoints.entries()) {
      const quote = `@${e.method === "GET" ? "Get" : "Post"}Mapping("${e.path}")`;
      const id = `e-${b.short}-${n}`;
      facts.push({
        kind: "entry",
        id,
        repo,
        component: b.component,
        entryType: "rest",
        method: e.method,
        path: e.path,
        cite: { file, line: ++line, value: e.path, quote },
        ...tail,
      });
      const names = k.nested && i === 1 ? ["customer.address.city", "items[].sku"] : ["status"];
      for (const [m, name] of names.entries())
        facts.push({
          kind: "field",
          id: `${id}.response.f${m}`,
          repo,
          owner: id,
          side: "response",
          name,
          type: "string",
          cite: { file, line: ++line, value: name, quote: `// ${name}` },
          ...tail,
        });
    }
    let c = 0;
    for (const x of k.calls.filter((y) => y.from % bases.length === i)) {
      const others = bases.map((_, j) => j).filter((j) => j !== i);
      const to = others[x.to % others.length]!;
      const ep = bases[to]!.endpoints[x.ep % 3]!;
      const via = x.via === "proxy" && (!gw || to !== 0) ? "host" : x.via;
      const host =
        via === "host"
          ? bases[to]!.host
          : via === "proxy"
            ? GATEWAY_HOST
            : via === "token"
              ? k.token === "at"
                ? `@forge${bases[to]!.cls}Url@`
                : `\${FORGE_${bases[to]!.short.toUpperCase()}_URL}`
              : "api.northwind-pay.example";
      const path =
        via === "proxy" ? basePath + ep.path : via === "outside" ? "/v2/charges" : ep.path;
      const method = via === "outside" ? "POST" : ep.method;
      // Every repo's calls are `c-0`, `c-1`, … as assistants name them in the field: a loose
      // end's id carries its repo (ADR 0124 addendum E-ids), so they stay a record each.
      const id = `c-${c++}`;
      const url = `https://${host}${path}`;
      const at = { file: client, line: ++line };
      facts.push({
        kind: "call",
        id,
        repo,
        component: b.component,
        callType: "rest",
        method,
        path,
        host,
        sync: "sync",
        cite: { ...at, value: path, quote: `rest.exchange("${url}"` },
        ...tail,
      });
      calls.push({
        repo,
        fact: id,
        ...at,
        via,
        host,
        ...(via === "host" ? { to: bases[to]!.component } : {}),
      });
    }
    await snapshot(root, repo, facts, SHAPE_COMMIT);
  }
  if (gw) {
    // The proxy's routes, each forwarding to its target token, and the token per environment.
    const token = k.proxy === "at" ? "@targetUrl@" : "${TARGET_URL}";
    const name = k.proxy === "at" ? "@targetUrl@" : "TARGET_URL";
    const facts: Record<string, unknown>[] = [];
    const proxies = "apiproxy/proxies/default.xml";
    const target = { file: "apiproxy/targets/TE-Service.xml", line: 1, value: token };
    const bp = { file: proxies, line: 1, value: basePath };
    for (const [n, e] of bases[0]!.endpoints.entries()) {
      const cond = `<Condition>(proxy.pathsuffix MatchesPath "${e.path}") and (request.verb = "${e.method}")</Condition>`;
      const cite = { file: proxies, line: 2 + n, value: e.path, quote: cond };
      facts.push({
        kind: "entry",
        id: `r-${n}`,
        repo: gw,
        entryType: "rest",
        method: e.method,
        path: basePath + e.path,
        handler: `${gw}/Route${n}`,
        cite: { ...cite, with: [bp] },
        ...tail,
      });
      facts.push({
        kind: "call",
        id: `f-${n}`,
        repo: gw,
        callType: "rest",
        method: e.method,
        path: e.path,
        host: token,
        from: `r-${n}`,
        cite: { ...cite, with: [target] },
        ...tail,
      });
      calls.push({
        repo: gw,
        fact: `f-${n}`,
        file: proxies,
        line: 2 + n,
        via: "forward",
        host: token,
        to: bases[0]!.component,
      });
    }
    for (const [n, env] of ["dev", "prod"].entries()) {
      const url = `https://${env === "prod" ? "" : `${env}-`}${bases[0]!.host}`;
      facts.push({
        kind: "config",
        id: `t-${env}`,
        repo: gw,
        settingKind: "config",
        key: name,
        value: url,
        env,
        cite: {
          file: "config.json",
          line: 3 + n * 3,
          value: url,
          quote: `"value": "${url}"`,
          with: [
            { file: "config.json", line: 2 + n * 3, value: name },
            { file: "config.json", line: 1 + n * 3, value: env },
          ],
        },
        ...tail,
      });
    }
    await snapshot(root, gw, facts, SHAPE_COMMIT);
  }
  return { repos: [...bases.map((_, i) => idOf(i)), ...(gw ? [gw] : [])], calls };
}
