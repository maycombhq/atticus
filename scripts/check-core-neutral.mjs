#!/usr/bin/env node
// No ecosystem-specific names in core (ADR 0035 point 4). Core packages never branch on a
// vendor, product, framework, company or industry name: that knowledge lives in adapters,
// extractors, ingestors, dialects and org-pack data. This check reads the code of the core
// packages (comments are skipped: an example in a doc comment isn't a branch) and fails on any
// name from the list below that isn't allowlisted, with a reason, further down.
//
//   node scripts/check-core-neutral.mjs           check
//   node scripts/check-core-neutral.mjs --list    print every hit, allowlisted or not

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Core packages: the product logic that must work the same for any ecosystem. Left out, on
 * purpose: adapters (adapter types are their job), extractors and ingestors (they read named
 * formats and frameworks), speckit and openspec-adapter (adapters to two named spec frameworks),
 * assistant-files and assistant-kit (they write files for named coding assistants), ai (model
 * runtimes are provider adapters), executors (transports), stubs and diagrams (writers of named
 * file formats), synth and fixtures (test estates and fixture loaders), and cli (it wires
 * adapter-specific commands together). Only `src/` is read: tests and fixtures may name anything.
 */
export const CORE_PACKAGES = [
  "core",
  "sdk",
  "changes",
  "naysayer",
  "index",
  "scanner",
  "reconcile",
  "features",
  "knowledge",
  "planner",
  "taskrun",
  "glossary",
  "testgen",
  "ci",
  "intake",
  "adopt",
  "workspace",
  "conformance",
  "release",
];

/**
 * The maintained list: lowercase names, matched as whole words, camelCase parts or two joined
 * camelCase parts (so OpenShift, GitHub and ServiceNow are caught), and two-word phrases.
 */
export const NAMES = {
  cloud: [
    "aws",
    "amazon",
    "azure",
    "microsoft",
    "gcp",
    "google",
    "alibaba",
    "oracle",
    "ibm",
    "heroku",
    "cloudflare",
    "digitalocean",
    "openshift",
    "redhat",
    "vmware",
  ],
  gateways: ["apigee", "kong", "mulesoft", "tyk", "layer7", "axway"],
  "work and service desk": [
    "jira",
    "atlassian",
    "servicenow",
    "snow",
    "ado",
    "azure devops",
    "confluence",
    "sharepoint",
    "trello",
    "asana",
    "zendesk",
    "remedy",
  ],
  "git hosts": ["github", "gitlab", "bitbucket"],
  "chat and design": ["slack", "teams", "figma", "lucidchart", "lucid", "visio", "miro"],
  observability: [
    "datadog",
    "splunk",
    "dynatrace",
    "newrelic",
    "new relic",
    "appdynamics",
    "pagerduty",
    "grafana",
    "elastic",
    "kibana",
  ],
  frameworks: [
    "spring",
    "quarkus",
    "micronaut",
    "django",
    "flask",
    "fastapi",
    "express",
    "nestjs",
    "rails",
    "laravel",
    "aspnet",
    "dotnet",
    "react",
    "angular",
    "vue",
    "kafka",
    "rabbitmq",
    "activemq",
    "tibco",
    "solace",
    "hibernate",
    "springboot",
  ],
  "data and saas": [
    "snowflake",
    "databricks",
    "bigquery",
    "redshift",
    "salesforce",
    "sap",
    "workday",
    "stripe",
    "twilio",
    "sendgrid",
    "okta",
    "auth0",
  ],
  assistants: ["copilot", "claude", "openai", "anthropic", "gemini", "chatgpt"],
  industries: [
    "bank",
    "banking",
    "fintech",
    "insurance",
    "insurer",
    "healthcare",
    "pharma",
    "telco",
  ],
};

/**
 * Allowed hits, each with the reason. `file` is relative to the repo root; `names` the names
 * allowed in that file. Prefer moving the knowledge out of core over adding a line here.
 */
const SNOW_ARTIFACT =
  "service-desk drafts are the `snow` change artifact (snow.md) and org-pack folder process/snow (ADR 0029, 0037); renaming them is a contract change (debt: rename to a neutral service-desk name)";
const CLAUDE_RUNTIME =
  "C5 runtime kind `headless-claude-code` (ADR 0036), an adapter type listed in agent definitions";
const OWN_HOST = "the project's own JSON Schema host (maycombhq.github.io), not a vendor branch";
const WORK_REFS = "C1 ExternalRef.system adapter-type values (ado, jira) and their URL shapes";

export const ALLOW = [
  {
    file: "packages/core/src/schema/orgpack.ts",
    names: ["gcp", "aws", "elastic"],
    reason:
      "ADR 0132: the default clouds a sources.yaml appliesTo.platforms takes in (a cloud stands for its platforms); a source names any other platform itself",
  },
  {
    file: "packages/core/src/facts-join.ts",
    names: ["apigee"],
    reason:
      "a gateway bundle's folder names (apiproxy/, sharedflowbundle/) say an entry is a gateway route whatever the repo's type says, so the join follows the hop (ADR 0124 addenda A-gateway and A-gateway2); the reading rules and the policy kinds stay in the assistant's protocol and the verifier",
  },
  {
    file: "packages/core/src/api.ts",
    names: ["confluence", "ado", "sharepoint", "claude"],
    reason:
      "the wiki types sources.yaml takes are the C6 contract's enum (ADR 0101), named in the API for the app's source form; claude-code is a surface the prompt history records from, as runtime.yaml's assistants enum names it (ADR 0110)",
  },
  {
    file: "packages/knowledge/src/knowledge-scan.ts",
    names: ["teams"],
    reason:
      "the English word: people's teams are a kind of knowledge item (a party), not the chat product",
  },
  {
    file: "packages/planner/src/needs.ts",
    names: ["teams", "kafka", "claude"],
    reason:
      "teams is the English word (the teams a change involves); kafka-topic-request is an example item id in the prompt; headless-claude-code is a C5 runtime kind (ADR 0014)",
  },
  // --- adapter-type enums of the contracts, and defaults that name adapter types
  {
    file: "packages/core/src/schema/kinds.ts",
    names: ["ado", "jira", "snow", "teams"],
    reason:
      "C1 adapter-type enums: ExternalRef.system, OwnerQuestion.channel, ProcessArtifact.artifactType",
  },
  {
    file: "packages/core/src/schema/orgpack.ts",
    names: [
      "ado",
      "anthropic",
      "azure",
      "azure devops",
      "bitbucket",
      "claude",
      "confluence",
      "copilot",
      "figma",
      "gemini",
      "github",
      "gitlab",
      "jira",
      "openai",
      "servicenow",
      "sharepoint",
      "slack",
      "snow",
      "teams",
    ],
    reason:
      "C6 runtime.yaml and sources.yaml adapter-type enums (work tracker, service desk, Git host, wiki, design tool, notifications, model providers, assistants) and the process/snow artifact",
  },
  { file: "packages/core/src/schema/ai.ts", names: ["claude"], reason: CLAUDE_RUNTIME },
  { file: "packages/core/src/schema/review.ts", names: ["snow"], reason: SNOW_ARTIFACT },
  {
    file: "packages/core/src/orgpack-defaults.ts",
    names: ["claude", "copilot", "snow"],
    reason:
      "built-in default runtime and assistant adapter types, and the snow artifact in default change types",
  },
  { file: "packages/core/src/orgpack-load.ts", names: ["snow"], reason: SNOW_ARTIFACT },
  { file: "packages/core/src/json-schema.ts", names: ["github"], reason: OWN_HOST },
  { file: "packages/core/src/schema/executors.ts", names: ["github"], reason: OWN_HOST },
  // --- the service-desk artifact, named after one product (debt, see SNOW_ARTIFACT)
  { file: "packages/changes/src/lifecycle.ts", names: ["snow"], reason: SNOW_ARTIFACT },
  { file: "packages/changes/src/policy.ts", names: ["snow"], reason: SNOW_ARTIFACT },
  { file: "packages/naysayer/src/index.ts", names: ["snow"], reason: SNOW_ARTIFACT },
  { file: "packages/naysayer/src/ai.ts", names: ["snow"], reason: SNOW_ARTIFACT },
  { file: "packages/naysayer/src/artifacts.ts", names: ["snow"], reason: SNOW_ARTIFACT },
  { file: "packages/naysayer/src/checks/catalog.ts", names: ["snow"], reason: SNOW_ARTIFACT },
  { file: "packages/naysayer/src/checks/index.ts", names: ["snow"], reason: SNOW_ARTIFACT },
  { file: "packages/planner/src/bar.ts", names: ["snow"], reason: SNOW_ARTIFACT },
  { file: "packages/planner/src/index.ts", names: ["snow"], reason: SNOW_ARTIFACT },
  { file: "packages/planner/src/plan.ts", names: ["snow"], reason: SNOW_ARTIFACT },
  { file: "packages/planner/src/snow.ts", names: ["snow"], reason: SNOW_ARTIFACT },
  {
    file: "packages/planner/src/stages/schema.ts",
    names: ["figma"],
    reason:
      "a feature can start from a Figma file export (plan 4.4, ADR 0087): the design entry names the format it reads",
  },
  ...[
    "packages/planner/src/stages/index.ts",
    "packages/planner/src/stages/figma.ts",
    "packages/planner/src/stages/feature.ts",
    "packages/planner/src/stages/design-check.ts",
  ].map((file) => ({
    file,
    names: ["figma"],
    reason:
      "the feature stage reads a Figma file export and checks the design against it (plan 4.4, ADR 0087): the reader names the format it reads",
  })),
  ...[
    "packages/planner/src/stages/loop.ts",
    "packages/knowledge/src/knowledge-scan.ts",
    "packages/knowledge/src/knowledge-ask.ts",
  ].map((file) => ({
    file,
    names: ["claude"],
    reason:
      "the agent lists the runtimes it may use; headless-claude-code is a runtime kind in the C5 contract (ADR 0014)",
  })),
  {
    file: "packages/planner/src/stages/finding-kind.ts",
    names: ["teams"],
    reason:
      "org-pack/teams/<team>/checklists is the org pack's own folder of team checklists, not the chat product",
  },
  { file: "packages/planner/src/sync.ts", names: ["snow"], reason: SNOW_ARTIFACT },
  { file: "packages/release/src/context.ts", names: ["snow"], reason: SNOW_ARTIFACT },
  {
    file: "packages/planner/src/templates.ts",
    names: ["snow", "claude"],
    reason: `${SNOW_ARTIFACT}; ${CLAUDE_RUNTIME}`,
  },
  { file: "packages/adopt/src/orgpack-files.ts", names: ["snow"], reason: SNOW_ARTIFACT },
  { file: "packages/adopt/src/absorb/critic.ts", names: ["snow"], reason: SNOW_ARTIFACT },
  {
    file: "packages/conformance/src/spec.ts",
    names: ["snow"],
    reason: "the spec documents where service-desk templates live today (process/snow)",
  },
  // --- the C5 runtime kind in agent definitions
  { file: "packages/taskrun/src/run.ts", names: ["claude"], reason: CLAUDE_RUNTIME },
  { file: "packages/taskrun/src/prompt.ts", names: ["claude"], reason: CLAUDE_RUNTIME },
  { file: "packages/features/src/naming.ts", names: ["claude"], reason: CLAUDE_RUNTIME },
  { file: "packages/glossary/src/proposals.ts", names: ["claude"], reason: CLAUDE_RUNTIME },
  { file: "packages/planner/src/prose.ts", names: ["claude"], reason: CLAUDE_RUNTIME },
  { file: "packages/planner/src/draft.ts", names: ["claude"], reason: CLAUDE_RUNTIME },
  { file: "packages/naysayer/src/ai.ts", names: ["claude"], reason: CLAUDE_RUNTIME },
  { file: "packages/testgen/src/names.ts", names: ["claude"], reason: CLAUDE_RUNTIME },
  // --- work-item references (C1 ExternalRef adapter types)
  {
    file: "packages/features/src/decisions.ts",
    names: ["ado", "jira", "confluence"],
    reason: `${WORK_REFS}; a wiki URL is recognised by its name`,
  },
  { file: "packages/features/src/links.ts", names: ["ado", "jira"], reason: WORK_REFS },
  {
    file: "packages/intake/src/work-items.ts",
    names: ["ado", "jira"],
    reason: `${WORK_REFS}: work-item exports are read by their export shape`,
  },
  { file: "packages/knowledge/src/feature-checks.ts", names: ["ado", "jira"], reason: WORK_REFS },
  {
    file: "packages/knowledge/src/gaps.ts",
    names: ["ado", "azure", "azure devops", "teams"],
    reason: "maps runtime.yaml adapter types to the C1 OwnerQuestion.channel enum",
  },
  {
    file: "packages/knowledge/src/sources.ts",
    names: ["confluence", "sharepoint"],
    reason: "C6 sources.yaml wiki adapter types (ADR 0132: the export types)",
  },
  {
    file: "packages/knowledge/src/exports.ts",
    names: ["confluence", "sharepoint"],
    reason:
      "C6 sources.yaml export types (ADR 0132): the folder a named wiki exports to, read as that wiki writes it",
  },
  // --- generic words that collide with a product name
  {
    file: "packages/naysayer/src/round.ts",
    names: ["teams"],
    reason: "the org pack's teams/ folder (team rule layer), not the chat product",
  },
  {
    file: "packages/naysayer/src/stats.ts",
    names: ["teams"],
    reason: "the org pack's teams/ folder (team rule layer), not the chat product",
  },
  {
    file: "packages/adopt/src/absorb/absorb.ts",
    names: ["vue", "github", "claude", "copilot"],
    reason:
      "absorb reads the named assistant files a repo already has (.github prompts and agents, .claude commands, CLAUDE.md) and a source-file extension list; an adapter concern living in adopt (ADR 0038)",
  },
  // --- adapter-type data and detection heuristics living in core packages (debt: move to adapters, extractors or org-pack data)
  {
    file: "packages/adopt/src/adopt.ts",
    names: ["claude", "copilot", "github"],
    reason:
      "adopt writes the assistant files for the named assistants (ADR 0038); should delegate to assistant-files",
  },
  {
    file: "packages/adopt/src/discover.ts",
    names: ["claude", "github"],
    reason: "repo discovery skips assistant and Git host folders by name (ADR 0038)",
  },
  {
    file: "packages/adopt/src/detect.ts",
    names: [
      "angular",
      "apigee",
      "django",
      "dotnet",
      "express",
      "fastapi",
      "flask",
      "hibernate",
      "kong",
      "micronaut",
      "quarkus",
      "react",
      "spring",
      "vue",
    ],
    reason:
      "repo-type detection from named build files, an extractor's job living in adopt (ADR 0038); should move to extractors. The table of framework names a repo's facts declare (ADR 0124 addendum A-framework) is the same job: what each framework means lives in verify, and this maps its name to a repo type",
  },
  {
    file: "packages/ci/src/snippets.ts",
    names: ["azure", "github", "gitlab"],
    reason: "CI templates per CI system type (ADR 0039): adapter-type data",
  },
  {
    file: "packages/changes/src/codeowners.ts",
    names: ["github"],
    reason:
      "the CODEOWNERS locations Git hosts read (ADR 0029); should move into the Git host adapter",
  },
  {
    file: "packages/features/src/graph.ts",
    names: ["angular", "react", "vue"],
    reason:
      "a heuristic recognising UI components by repo type (ADR 0031); should move to org-pack profile data",
  },
  {
    file: "packages/testgen/src/targets.ts",
    names: ["angular", "express", "micronaut", "quarkus", "react", "spring", "vue"],
    reason:
      "test-target choice by repo type (ADR 0039); should move to org-pack test-strategy data",
  },
  {
    file: "packages/intake/src/classify.ts",
    names: ["lucid", "visio"],
    reason:
      "input file-format detection (diagram formats), an ingestor concern living in intake (ADR 0026)",
  },
];

const flat = Object.entries(NAMES).flatMap(([group, names]) => names.map((n) => ({ n, group })));
const single = new Map(flat.filter((x) => !x.n.includes(" ")).map((x) => [x.n, x.group]));
const phrases = flat.filter((x) => x.n.includes(" "));

/** Blank out comments in TypeScript/JavaScript, keeping strings and line breaks. */
export function stripComments(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && d === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && d === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The names on one line of code. */
export function namesIn(line) {
  const hits = new Set();
  const lower = line.toLowerCase();
  for (const id of line.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []) {
    const parts = id
      .split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
      .map((p) => p.toLowerCase());
    const candidates = new Set([id.toLowerCase(), ...parts]);
    for (let k = 0; k + 1 < parts.length; k++) candidates.add(parts[k] + parts[k + 1]);
    for (const c of candidates) if (single.has(c)) hits.add(c);
  }
  for (const p of phrases)
    if (new RegExp(`\\b${p.n.replace(" ", "[\\s_-]+")}\\b`).test(lower)) hits.add(p.n);
  return [...hits];
}

function files(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries.sort()) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (/\.(ts|mts|js|mjs)$/.test(e) && !/\.d\.ts$/.test(e)) out.push(full);
  }
  return out;
}

export function check(root = ROOT) {
  const hits = [];
  for (const pkg of CORE_PACKAGES)
    for (const full of files(join(root, "packages", pkg, "src"))) {
      const file = relative(root, full).split(sep).join("/");
      const lines = stripComments(readFileSync(full, "utf8")).split("\n");
      lines.forEach((line, i) => {
        for (const n of namesIn(line)) {
          const allowed = ALLOW.find((a) => a.file === file && a.names.includes(n));
          hits.push({
            file,
            line: i + 1,
            name: n,
            group: single.get(n) ?? "phrase",
            allowed: !!allowed,
            text: line.trim(),
          });
        }
      });
    }
  return hits;
}

/** Allowlist entries (file and name) that no hit uses any more: remove them. */
export function staleAllow(hits) {
  const used = new Set(hits.filter((h) => h.allowed).map((h) => `${h.file}|${h.name}`));
  return ALLOW.flatMap((a) =>
    a.names.filter((n) => !used.has(`${a.file}|${n}`)).map((n) => ({ file: a.file, name: n })),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const hits = check();
  const bad = hits.filter((h) => !h.allowed);
  const stale = staleAllow(hits);
  if (stale.length > 0) {
    console.error(
      "Allowlist entries in scripts/check-core-neutral.mjs that nothing needs any more:",
    );
    for (const s of stale) console.error(`  ${s.file}  ${s.name}`);
    process.exit(1);
  }
  if (process.argv.includes("--list")) {
    for (const h of hits)
      console.log(
        `${h.allowed ? "allowed " : "        "}${h.file}:${h.line}  ${h.name} (${h.group})  ${h.text.slice(0, 120)}`,
      );
  }
  if (bad.length > 0) {
    console.error(
      `Ecosystem-specific names in core packages (ADR 0035) in ${bad.length} place(s):`,
    );
    for (const h of bad) console.error(`  ${h.file}:${h.line}  ${h.name} (${h.group})`);
    console.error(
      "Move the knowledge to an adapter, extractor, dialect or org-pack data, or allowlist it with a reason in scripts/check-core-neutral.mjs.",
    );
    process.exit(1);
  }
  console.log(
    `Core-neutral check passed (${CORE_PACKAGES.length} packages, ${hits.length} allowlisted).`,
  );
}
