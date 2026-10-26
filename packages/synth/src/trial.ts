import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  interfaceId,
  parseRecord,
  recordPath,
  serializeRecord,
  toCanonicalYaml,
  type CatalogRecord,
} from "@maycombhq/core";
import { prng } from "./index.js";

/**
 * A metarepo in the shape a real trial had: a catalog of about 1,500 records, the facts an
 * assistant wrote, 400 flows in specs/, knowledge items, open questions and one change on the
 * stage path with its stories and tasks. It is what the commands a person runs all day
 * (`atticus next`, `atticus change status`, `atticus questions list`) read, so the perf tests
 * can measure them on the shape of an estate rather than on a handful of fixture files.
 *
 * Everything is invented: the Forge ecosystem's names and the invented vendor Northwind Pay,
 * from fixed word lists, deterministic for a seed. Nothing here resembles any real estate.
 */

export interface TrialOptions {
  /** Repos in the manifest (the records, flows and facts are shared out over them). */
  repos?: number;
  /** Flows across every repo's spec (specs/<repo>/<flow>.yaml). */
  flows?: number;
  /** Facts the assistant wrote across every repo (facts/<repo>.jsonl). */
  facts?: number;
  /** Endpoints per repo. */
  endpoints?: number;
  /** Interfaces per repo. */
  interfaces?: number;
  /** Tables per repo. */
  tables?: number;
  /** Columns per table. */
  columns?: number;
  /** Knowledge items (knowledge/items/). */
  knowledge?: number;
  /** Open questions (questions/). */
  questions?: number;
  /** Stories of the change. */
  stories?: number;
  /** Tasks of the change. */
  tasks?: number;
  seed?: number;
}

export interface TrialEstate {
  root: string;
  /** The change the stages wrote, by id. */
  change: string;
  /** What was written, for a test to assert the shape it measures on. */
  counts: {
    repos: number;
    records: number;
    flows: number;
    facts: number;
    knowledge: number;
    questions: number;
    stories: number;
    tasks: number;
  };
}

const DEFAULTS = {
  repos: 40,
  flows: 400,
  facts: 2300,
  endpoints: 6,
  interfaces: 4,
  tables: 2,
  columns: 10,
  knowledge: 120,
  questions: 18,
  stories: 3,
  tasks: 14,
  seed: 7,
} satisfies Required<TrialOptions>;

/** Invented Forge-style words: nothing here names a real system. */
const NOUNS = [
  "ledger",
  "portal",
  "orders",
  "customers",
  "statements",
  "payments",
  "audit",
  "notices",
  "limits",
  "receipts",
  "mandates",
  "batches",
  "transfers",
  "balances",
  "holds",
  "refunds",
  "accounts",
  "schedules",
  "tags",
  "notes",
];
const ROLES = ["api", "bff", "job", "worker", "store", "view", "hub", "engine"];
const AT = "2026-10-19T09:00:00Z";
const DAY = "2026-10-19";

const pad = (n: number, w = 3) => String(n).padStart(w, "0");
const write = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
};

interface RepoShape {
  id: string;
  system: string;
  component: string;
  owner: string;
  type: string;
  noun: string;
}

function repoShapes(n: number, rnd: () => number): RepoShape[] {
  const out: RepoShape[] = [];
  for (let i = 0; i < n; i++) {
    const noun = NOUNS[i % NOUNS.length]!;
    const role = ROLES[Math.floor(rnd() * ROLES.length)]!;
    const id = `forge-${noun}-${role}-${pad(i)}`;
    out.push({
      id,
      system: `sys-${noun}`,
      component: id,
      owner: `team-${noun}`,
      type: role === "bff" ? "spring-boot" : role === "job" ? "batch-job" : "forge-service",
      noun,
    });
  }
  return out;
}

const cite = (repo: string, file: string, line: number) => ({
  source: "code" as const,
  repo,
  path: file,
  line,
  commit: "1".repeat(40),
  scannedAt: AT,
});

/** Every catalog record of the estate, in the mix a scan of it would find. */
function catalogOf(repos: RepoShape[], o: Required<TrialOptions>): CatalogRecord[] {
  const out: unknown[] = [];
  for (const s of new Set(repos.map((r) => r.system)))
    out.push({
      kind: "System",
      schemaVersion: 2,
      id: s,
      status: "current",
      confidence: "verified",
      evidence: [cite(repos.find((r) => r.system === s)!.id, "README.md", 1)],
      name: s.replace(/^sys-/, ""),
      boundary: "internal",
      repos: repos.filter((r) => r.system === s).map((r) => r.id),
    });
  // An invented vendor, so a change that calls out of the estate has somewhere to call.
  out.push({
    kind: "System",
    schemaVersion: 2,
    id: "northwind-pay",
    status: "current",
    confidence: "verified",
    evidence: [cite(repos[0]!.id, "README.md", 2)],
    name: "Northwind Pay",
    boundary: "vendor",
  });
  repos.forEach((r, i) => {
    out.push({
      kind: "Component",
      schemaVersion: 2,
      id: r.component,
      status: "current",
      confidence: "verified",
      evidence: [cite(r.id, "src/main/java/forge/App.java", 5)],
      system: r.system,
      repo: r.id,
      type: r.type === "spring-boot" ? "bff" : r.type === "batch-job" ? "batch-job" : "service",
    });
    out.push({
      kind: "DataStore",
      schemaVersion: 2,
      id: `${r.noun}-db-${pad(i)}`,
      status: "current",
      confidence: "verified",
      evidence: [cite(r.id, "src/main/resources/application.yml", 3)],
      storeType: "relational",
      ownerComponent: r.component,
    });
    for (let k = 0; k < o.endpoints; k++) {
      const method = k % 2 ? "POST" : "GET";
      const path = `/${r.noun}/v1/item${k}`;
      out.push({
        kind: "Endpoint",
        schemaVersion: 2,
        id: `${r.component}.op${k}`,
        status: "current",
        confidence: "verified",
        evidence: [cite(r.id, "src/main/java/forge/Endpoints.java", 10 + k * 4)],
        component: r.component,
        endpointType: "rest",
        method,
        pathOrTopic: path,
        normalizedPath: path,
        schemaRefs: [`${r.component}.schema${k % o.tables}`],
        auth: "oauth2",
      });
    }
    for (let k = 0; k < o.tables; k++) {
      const table = `${r.noun}-db-${pad(i)}.t${k}`;
      out.push({
        kind: "Table",
        schemaVersion: 2,
        id: table,
        status: "current",
        confidence: "verified",
        evidence: [cite(r.id, `src/main/resources/db/migration/V${k + 1}__init.sql`, 1)],
        dataStore: `${r.noun}-db-${pad(i)}`,
        name: `t${k}`,
        tableKind: "table",
        ownerComponent: r.component,
      });
      for (let c = 0; c < o.columns; c++)
        out.push({
          kind: "Column",
          schemaVersion: 2,
          id: `${table}.c${c}`,
          status: "current",
          confidence: "verified",
          evidence: [cite(r.id, `src/main/resources/db/migration/V${k + 1}__init.sql`, 2 + c)],
          table,
          name: `c${c}`,
          type: c === 0 ? "varchar(36)" : "varchar(120)",
          ...(c === 1 ? { classification: "confidential" } : {}),
        });
      out.push({
        kind: "Schema",
        schemaVersion: 3,
        id: `${r.component}.schema${k}`,
        status: "current",
        confidence: "verified",
        evidence: [cite(r.id, "src/main/java/forge/Payload.java", 6 + k)],
        format: "json-schema",
        ref: `schemas/${r.noun}-${k}.json`,
        fields: [
          { name: "id", type: "string", required: true },
          { name: "customerId", type: "string", classification: "confidential", required: true },
          { name: "amount", type: "number" },
        ],
      });
    }
    for (let k = 0; k < o.interfaces; k++) {
      const to = repos[(i + k + 1) % repos.length]!;
      if (to.id === r.id) continue;
      const path = `/${to.noun}/v1/item${k % o.endpoints}`;
      const method = k % 2 ? "POST" : "GET";
      out.push({
        kind: "Interface",
        schemaVersion: 2,
        id: interfaceId(r.component, to.component, method, path),
        status: "current",
        confidence: "verified",
        evidence: [cite(r.id, "src/main/java/forge/Clients.java", 8 + k * 6)],
        from: r.component,
        to: to.component,
        endpoint: `${to.component}.op${k % o.endpoints}`,
        via: "gateway",
        method,
        normalizedPath: path,
        auth: "oauth2",
        sync: "sync",
      });
    }
  });
  return out.map((raw) => {
    const r = parseRecord(raw);
    if (!r.ok)
      throw new Error(
        `the trial estate generated an invalid record: ${r.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      );
    return r.record;
  });
}

/** A flow of a repo, in the shape `atticus map` writes them. */
function flowOf(r: RepoShape, i: number, k: number, o: Required<TrialOptions>): CatalogRecord {
  const table = `${r.noun}-db-${pad(i)}.t${k % o.tables}`;
  const file = "src/main/java/forge/Endpoints.java";
  const raw = {
    kind: "Flow",
    schemaVersion: 2,
    id: `${r.component}.flow${k}`,
    status: "current",
    confidence: "inferred",
    evidence: [],
    component: r.component,
    name: `A client works with ${r.noun} (${k})`,
    template: "forge-service@1",
    trigger: {
      kind: "endpoint",
      ref: `${r.component}.op${k % o.endpoints}`,
      what: `${k % 2 ? "POST" : "GET"} /${r.noun}/v1/item${k % o.endpoints} is called`,
      evidence: [cite(r.id, file, 10 + k)],
    },
    steps: [
      {
        kind: "entry",
        what: "The request arrives with the id",
        data: { reads: ["id"] },
        evidence: [cite(r.id, file, 11 + k)],
      },
      {
        kind: "validate",
        what: "The caller's scope is checked",
        data: { checks: ["scope"] },
        evidence: [cite(r.id, file, 12 + k)],
      },
      {
        kind: "read",
        what: `The ${r.noun} row is read`,
        store: { table, columns: ["c0", "c1"] },
        evidence: [cite(r.id, file, 13 + k)],
      },
      {
        kind: "write",
        what: `The ${r.noun} row is written`,
        store: { table, columns: ["c0", "c2"] },
        evidence: [cite(r.id, file, 14 + k)],
      },
      {
        kind: "respond",
        what: "The result is returned",
        data: { returns: ["id", "amount"] },
        evidence: [cite(r.id, file, 15 + k)],
      },
    ],
    errors: [
      {
        when: "The row is missing",
        then: "404",
        evidence: [cite(r.id, file, 16 + k)],
      },
    ],
  };
  const p = parseRecord(raw);
  if (!p.ok)
    throw new Error(
      `the trial estate generated an invalid flow: ${p.issues.map((x) => `${x.path}: ${x.message}`).join("; ")}`,
    );
  return p.record;
}

/** The facts an assistant wrote for a repo (ADR 0124), as JSONL lines. */
function factsOf(r: RepoShape, i: number, n: number, o: Required<TrialOptions>): string {
  const lines: string[] = [];
  const commit = "1".repeat(40);
  for (let k = 0; k < n; k++) {
    const file = "src/main/java/forge/Endpoints.java";
    const which = k % 3;
    if (which === 0)
      lines.push(
        JSON.stringify({
          kind: "entry",
          id: `${r.component}.op${k % o.endpoints}`,
          repo: r.id,
          commit,
          entryType: "rest",
          method: k % 2 ? "POST" : "GET",
          path: `/${r.noun}/v1/item${k % o.endpoints}`,
          handler: `Endpoints.op${k % o.endpoints}`,
          cite: {
            file,
            line: 10 + (k % 40),
            value: `/${r.noun}/v1/item${k % o.endpoints}`,
            quote: `@ForgeEndpoint(path = "/${r.noun}/v1/item${k % o.endpoints}")`,
          },
          verified: "line",
          by: "assistant",
          conf: "declared",
        }),
      );
    else if (which === 1)
      lines.push(
        JSON.stringify({
          kind: "field",
          id: `${r.component}.op${k % o.endpoints}.f${k}`,
          repo: r.id,
          commit,
          owner: `${r.component}.op${k % o.endpoints}`,
          side: "request",
          name: `field${k}`,
          type: "string",
          required: k % 2 === 0,
          cite: {
            file: "src/main/java/forge/Payload.java",
            line: 6 + (k % 30),
            value: `field${k}`,
            quote: `String field${k};`,
          },
          verified: "line",
          by: "assistant",
          conf: "declared",
        }),
      );
    else
      lines.push(
        JSON.stringify({
          kind: "store",
          id: `${r.noun}-db-${pad(i)}.t${k % o.tables}.s${k}`,
          repo: r.id,
          commit,
          table: `${r.noun}-db-${pad(i)}.t${k % o.tables}`,
          op: k % 2 ? "write" : "read",
          columns: ["c0", "c1"],
          cite: {
            file: "src/main/java/forge/Repository.java",
            line: 12 + (k % 30),
            value: `t${k % o.tables}`,
            quote: `select c0, c1 from t${k % o.tables} where c0 = ?`,
          },
          verified: "line",
          by: "assistant",
          conf: "declared",
        }),
      );
  }
  return `${lines.join("\n")}\n`;
}

/** A knowledge item: an invented product or vendor a wiki page names. */
function knowledgeItem(i: number, repos: RepoShape[]): CatalogRecord {
  const noun = NOUNS[i % NOUNS.length]!;
  const vendor = i % 5 === 0;
  const quote = {
    source: "forge-wiki",
    page: `platform/${noun}-${pad(i)}.md`,
    section: "What it is",
    text: `The ${noun} ${vendor ? "vendor" : "product"} ${pad(i)} serves the Forge estate.`,
    snapshot: DAY,
    line: 3,
  };
  const raw = vendor
    ? {
        kind: "Party",
        schemaVersion: 2,
        id: `vendor-${noun}-${pad(i)}`,
        status: "current",
        confidence: "inferred",
        evidence: [
          { source: "document", path: quote.page, line: 3, repo: repos[i % repos.length]!.id },
        ],
        name: `Northwind ${noun} ${pad(i)}`,
        partyKind: "vendor",
        quote,
      }
    : {
        kind: "Product",
        schemaVersion: 2,
        id: `product-${noun}-${pad(i)}`,
        status: "current",
        confidence: "inferred",
        evidence: [
          { source: "document", path: quote.page, line: 3, repo: repos[i % repos.length]!.id },
        ],
        name: `Forge ${noun} ${pad(i)}`,
        productKind: "product",
        quote,
      };
  const p = parseRecord(raw);
  if (!p.ok)
    throw new Error(
      `the trial estate generated an invalid knowledge item: ${p.issues.map((x) => `${x.path}: ${x.message}`).join("; ")}`,
    );
  return p.record;
}

/** An open question in the shape a survey raises them. */
function questionOf(i: number, repo: string): string {
  const id = `q-${pad(i, 4)}${"ab12cd".slice(0, 8)}`.slice(0, 14);
  return toCanonicalYaml(
    {
      schemaVersion: 2,
      id: `q-${i.toString(16).padStart(12, "0")}`,
      askedBy: {
        step: "scan-survey",
        command: `atticus scan survey ${repo}`,
        at: AT,
      },
      repo,
      question: `Does ${repo} read its limits from config or from the ledger (${id})?`,
      options: [
        {
          label: "From config",
          means: "The limit is a setting of the service.",
          changes: "The flow reads a setting, not a table.",
        },
        {
          label: "From the ledger",
          means: "The limit is a row in the ledger.",
          changes: "The flow reads the ledger table.",
        },
      ],
      evidence: [`src/main/java/forge/Limits.java:${20 + i}`],
      scope: { level: "repo", id: repo },
      state: "open",
      rerun: `atticus scan survey ${repo}`,
    },
    ["schemaVersion", "id"],
  );
}

/** The change the stages wrote: its placement, target flows, stories and tasks. */
async function writeChange(
  root: string,
  repos: RepoShape[],
  o: Required<TrialOptions>,
): Promise<string> {
  const id = "raise-transfer-limit";
  const dir = join(root, "openspec", "changes", id);
  const touched = repos.slice(0, 4);
  await write(
    join(dir, "change.yaml"),
    toCanonicalYaml(
      {
        schemaVersion: 1,
        id,
        title: "Raise the daily transfer limit",
        type: "feature",
        template: "feature",
        state: "plan",
        authors: { brief: ["pat"], stories: ["bao"], tasks: ["bao"] },
        createdAt: AT,
        createdBy: "pat",
        handoffs: [
          {
            phase: "define",
            state: "merged",
            approvals: [{ at: AT, by: "pat", roles: ["product-owner"] }],
            artifacts: [],
            branch: `handoff/${id}/define`,
            by: "pat",
            openedAt: AT,
            pr: { number: 1, url: "https://git.example.com/forge/forge-metarepo/pull/1" },
            reviewers: ["forge/platform"],
            updatedAt: AT,
          },
          {
            phase: "design",
            state: "merged",
            approvals: [{ at: AT, by: "avery", roles: ["architect"] }],
            artifacts: [],
            branch: `handoff/${id}/design`,
            by: "ari",
            openedAt: AT,
            pr: { number: 2, url: "https://git.example.com/forge/forge-metarepo/pull/2" },
            reviewers: ["avery"],
            updatedAt: AT,
          },
        ],
        history: [
          { from: "draft", to: "define", at: AT, by: "pat", reason: "Created" },
          { from: "define", to: "design", at: AT, by: "pat", pr: 1, reason: "Define merged" },
          { from: "design", to: "plan", at: AT, by: "avery", pr: 2, reason: "Design merged" },
        ],
        owners: {
          architect: ["ari", "avery"],
          "business-analyst": ["bao"],
          developer: ["dev", "dee"],
          "product-owner": ["pat"],
          qa: ["quinn"],
        },
        systems: touched.map((r) => r.system),
        touches: {
          dataStores: [],
          interfaces: [],
          records: [],
          repos: touched.map((r) => r.id),
          tables: [],
        },
      },
      ["schemaVersion", "id", "title", "type", "template", "state"],
    ),
  );
  await write(
    join(dir, "brief.md"),
    `# Raise the daily transfer limit\n\nA customer may transfer more in a day, and the limit is checked where the transfer is posted.\n`,
  );
  // The placement the feature stage wrote: today's flows it changes, and a new one.
  await write(
    join(dir, "feature.yaml"),
    toCanonicalYaml(
      {
        schemaVersion: 1,
        change: id,
        flows: touched.map((r, k) => ({
          id: `${r.component}.flow${k}`,
          how: k === 3 ? "read" : "change",
        })),
        newFlows: [{ repo: touched[0]!.id, name: "Check the raised limit" }],
      },
      ["schemaVersion", "change"],
    ),
  );
  // The target flows the architecture stage wrote, one per changed flow.
  for (const [k, r] of touched.slice(0, 3).entries()) {
    const table = `${r.noun}-db-${pad(repos.indexOf(r))}.t0`;
    await write(
      join(dir, "target-flows", `${r.component}.flow${k}.yaml`),
      [
        `# The target of flow ${r.component}.flow${k} (ADR 0087).`,
        "schemaVersion: 2",
        `flow: ${r.component}.flow${k}`,
        `repo: ${r.id}`,
        "change: modify",
        "why: The daily limit is checked where the transfer is posted.",
        "steps:",
        "  - op: add",
        "    after: 1",
        `    at: src/main/java/forge/Endpoints.java:${12 + k}`,
        "    kind: validate",
        "    what: Refuse with 403 unless the caller's token holds the transfers:post scope.",
        "    fields:",
        "      checks:",
        "        - scope",
        "        - customerId",
        "    why: The brief narrows who may post a transfer.",
        "  - op: add",
        "    after: 2",
        "    kind: read",
        "    what: Read the customer's daily total so far.",
        "    store:",
        `      table: ${table}`,
        "      columns:",
        "        - c0",
        "        - c1",
        "      classification:",
        "        c1: confidential",
        "    why: The limit is checked against today's total.",
        "  - op: add",
        "    after: 3",
        "    kind: call-out",
        "    what: Northwind Pay checks the velocity of the transfer.",
        "    to:",
        "      component: northwind-pay",
        "      entry: POST /v1/velocity",
        "      new: true",
        "    fields:",
        "      sends:",
        "        - customerId",
        "        - amount",
        "      returns:",
        "        - verdict",
        "    why: The velocity check the brief asks for.",
        "  - op: change",
        "    step: 4",
        "    kind: write",
        "    what: The transfer is posted only under the raised limit.",
        "    store:",
        `      table: ${table}`,
        "      columns:",
        "        - c0",
        "        - c2",
        "    fields:",
        "      required:",
        "        - limitRef",
        "    why: The posted row names the limit it was checked against.",
        "",
      ].join("\n"),
    );
  }
  // The stories the stories stage wrote, and the tasks under their repos.
  const storyIds = Array.from(
    { length: o.stories },
    (_, k) =>
      `s${k + 1}-${["refuse-over-limit", "show-remaining", "audit-refusals"][k] ?? `story${k + 1}`}`,
  );
  for (const [k, s] of storyIds.entries())
    await write(
      join(dir, "stories", `${s}.md`),
      [
        `# ${s}`,
        "",
        `As a customer, I want the raised daily limit respected, so that a transfer under it is posted (${k + 1}).`,
        "",
        "## Acceptance",
        "",
        "- [ ] A transfer over the limit is refused with 422.",
        "- [ ] A transfer under the limit is posted.",
        "",
      ].join("\n"),
    );
  await write(
    join(dir, "stories.md"),
    [`# Stories`, "", ...storyIds.map((s, k) => `${k + 1}. ${s}`), ""].join("\n"),
  );
  const lines: string[] = ["# Tasks", ""];
  let n = 0;
  touched.forEach((r, g) => {
    lines.push(`## ${r.id}`, "");
    const take = g === 0 ? o.tasks - 3 * (touched.length - 1) : 3;
    for (let k = 0; k < take; k++) {
      n++;
      lines.push(
        `- [${n <= 4 ? "x" : " "}] ${g + 1}.${k + 1} ${
          [
            "Add the migration",
            "Check the limit, with tests",
            "Call the velocity check, with tests",
          ][k % 3]
        } (story ${storyIds[n % storyIds.length]})`,
      );
    }
    lines.push("");
  });
  await write(join(dir, "tasks.md"), lines.join("\n"));
  // The stage loops: feature and architecture done, stories under way.
  for (const [stage, state] of [
    ["feature", "done"],
    ["architecture", "done"],
    ["stories", "waiting"],
  ] as const)
    await write(
      join(dir, "stage", `${stage}.yaml`),
      [
        `# The ${stage} stage's loop (ADR 0087). Atticus writes this file.`,
        "schemaVersion: 1",
        `change: ${id}`,
        `stage: ${stage}`,
        "iteration: 1",
        `state: ${state}`,
        `updatedAt: ${AT}`,
        "critic:",
        `  - gate: ${stage === "feature" ? "define" : stage === "architecture" ? "design" : "plan"}`,
        "    round: 1",
        "findings: []",
        "questions: []",
        "",
      ].join("\n"),
    );
  return id;
}

/** Write the trial estate as a metarepo at `dir`. Nothing is scanned: the files are the estate. */
export async function writeTrialEstate(dir: string, opts: TrialOptions = {}): Promise<TrialEstate> {
  const o = { ...DEFAULTS, ...opts };
  const rnd = prng(o.seed);
  const repos = repoShapes(o.repos, rnd);

  // The org pack: the manifest, the pack and one wiki source. The change types, gates and
  // test strategy are the built-in defaults, as a metarepo that hasn't written its own has.
  await write(
    join(dir, "org-pack", "pack.yaml"),
    toCanonicalYaml(
      {
        schemaVersion: 1,
        name: "forge",
        version: "0.1.0",
        owner: "team-platform",
        reviewWindowDays: 90,
      },
      ["schemaVersion", "name", "version"],
    ),
  );
  await write(
    join(dir, "org-pack", "sources.yaml"),
    "schemaVersion: 1\nwikis:\n  - { id: forge-wiki, type: markdown-folder, location: ../../inputs/wiki, owner: team-platform }\n",
  );
  await write(
    join(dir, "org-pack", "profiles", "forge", "repos.manifest.yaml"),
    toCanonicalYaml(
      {
        schemaVersion: 1,
        platform: "forge",
        repos: repos.map((r) => ({
          id: r.id,
          url: `https://git.example.com/forge/${r.id}.git`,
          defaultBranch: "main",
          type: r.type,
          owner: r.owner,
          system: r.system,
          component: r.component,
        })),
      },
      ["schemaVersion", "platform", "id"],
    ),
  );
  for (const r of repos)
    await write(
      join(dir, "org-pack", "scan", `${r.id}.yaml`),
      `schemaVersion: 1\nrepo: ${r.id}\nexclude: []\nprefixes: []\nclients: []\n`,
    );

  // The catalog the last scan wrote.
  const records = catalogOf(repos, o);
  for (const r of records)
    await write(join(dir, "catalog", "generated", ...recordPath(r).split("/")), serializeRecord(r));

  // The flows in specs/, shared out over the repos, with each repo's spec header.
  const perRepo = Math.floor(o.flows / repos.length);
  let flows = 0;
  for (const [i, r] of repos.entries()) {
    const n = i < o.flows % repos.length ? perRepo + 1 : perRepo;
    await write(
      join(dir, "specs", r.id, "spec.yaml"),
      toCanonicalYaml(
        {
          schemaVersion: 1,
          repo: r.id,
          commit: "1".repeat(40),
          template: "facts@1",
          drafted: { at: AT },
          flows: Array.from({ length: n }, (_, k) => `${r.component}.flow${k}`),
        },
        ["schemaVersion", "repo", "commit", "template"],
      ),
    );
    for (let k = 0; k < n; k++) {
      const flow = flowOf(r, i, k, o);
      await write(join(dir, "specs", r.id, `${flow.id}.yaml`), serializeRecord(flow));
      flows++;
    }
  }

  // The facts the assistant wrote, shared out over the repos.
  const factsPer = Math.floor(o.facts / repos.length);
  let facts = 0;
  for (const [i, r] of repos.entries()) {
    const n = i < o.facts % repos.length ? factsPer + 1 : factsPer;
    await write(join(dir, "facts", `${r.id}.jsonl`), factsOf(r, i, n, o));
    facts += n;
  }

  // The knowledge a scan of the wiki wrote.
  for (let i = 0; i < o.knowledge; i++) {
    const item = knowledgeItem(i, repos);
    await write(
      join(dir, "knowledge", "items", ...recordPath(item).split("/")),
      serializeRecord(item),
    );
  }
  await write(
    join(dir, "knowledge", "report.yaml"),
    toCanonicalYaml(
      {
        schemaVersion: 1,
        scannedAt: AT,
        snapshots: [{ source: "forge-wiki", date: DAY, pages: o.knowledge }],
        items: o.knowledge,
      },
      ["schemaVersion", "scannedAt"],
    ),
  );
  await write(
    join(dir, "knowledge", "snapshots", "forge-wiki", DAY, "index.md"),
    `# The Forge wiki on ${DAY}\n`,
  );

  // The open questions the survey raised.
  for (let i = 0; i < o.questions; i++)
    await write(
      join(dir, "questions", `q-${i.toString(16).padStart(12, "0")}.yaml`),
      questionOf(i, repos[i % repos.length]!.id),
    );

  // OpenSpec over the changes, as a metarepo set up with it has.
  await write(
    join(dir, "openspec", "config.yaml"),
    "# The Forge metarepo's OpenSpec settings (fixture).\nschema: spec-driven\n\ncontext: |\n  The invented Forge estate.\n",
  );
  const change = await writeChange(dir, repos, o);

  return {
    root: dir,
    change,
    counts: {
      repos: repos.length,
      records: records.length,
      flows,
      facts,
      knowledge: o.knowledge,
      questions: o.questions,
      stories: o.stories,
      tasks: o.tasks,
    },
  };
}
