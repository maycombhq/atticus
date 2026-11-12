#!/usr/bin/env node
/**
 * The catalog build's benchmark (ADR 0195 point 9): a synthetic estate of readers slots, built
 * cold, built again unchanged, and built with one slot changed, each in its own process (so no
 * in-process cache carries over), with the CPU time and the peak RSS of each.
 *
 * Not part of `pnpm check`. Build the scanner first (`pnpm turbo run build --filter=@maycombhq/scanner...`).
 *
 *   node packages/scanner/bench/build-bench.mjs --repos 40 --records 2500
 *   node packages/scanner/bench/build-bench.mjs --repos 40 --records 600 --events 30 --fanout 6
 *   node packages/scanner/bench/build-bench.mjs --repos 4 --records 300 --keep --dir /tmp/x
 *
 * Options: --repos N, --records M (per repo, about), --events E (topics each repo publishes),
 * --fanout F (subscribers in other repos per topic), --calls C (cross-repo calls per repo; default
 * M/10), --phases cold,unchanged,one (default all three), --dir D (where the estate goes; a temp
 * folder by default), --keep (leave it there), --cpu-prof (a .cpuprofile per phase, in D),
 * --timeout S (seconds a phase may take; default 600), --scanner F (another build's
 * packages/scanner/dist/index.js, to compare with: an earlier commit's checkout, say).
 *
 * The estate is invented (the Forge style of fixtures/forge: nouns from a fixed list), and the
 * same options always give the same slots. Each phase prints one JSON line; the table at the
 * end compares them.
 */
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCANNER = join(HERE, "..", "dist", "index.js");
const CORE = join(HERE, "..", "node_modules", "@maycombhq", "core", "dist", "index.js");

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) o[k] = true;
    else {
      o[k] = v;
      i++;
    }
  }
  return o;
}

// ------------------------------------------------------------------ the estate

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
  "product",
  "offer",
  "loan",
  "deposit",
  "hold",
  "sweep",
  "pool",
  "batch",
  "settlement",
  "clearing",
  "receipt",
  "alert",
  "profile",
  "document",
  "contract",
  "schedule",
  "quote",
  "order",
  "shipment",
  "voucher",
];
const STATES = ["created", "updated", "completed", "failed", "approved"];
const COMMIT = "b".repeat(40);
const AT = "2026-10-18T09:00:00Z";
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
const hex = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const pad = (n) => String(n).padStart(2, "0");

/** mulberry32, as packages/synth: the same seed gives the same estate everywhere. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function estate(o, core) {
  const N = o.repos;
  const M = o.records;
  const rnd = prng(195);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const repoId = (r) => `synth-repo-${pad(r)}`;
  const sysId = (r) => `sys-${pad(r)}`;
  const compsOf = Math.max(2, Math.round(M / 250));
  const compId = (r, j) => `svc-${pad(r)}-${j}`;
  const ev = (r, path, extra = {}) => ({
    commit: COMMIT,
    extractor: "spring@1.2.0",
    line: 1 + Math.floor(rnd() * 200),
    path,
    repo: repoId(r),
    scannedAt: AT,
    source: "code",
    ...extra,
  });
  const base = (kind, id, confidence = "verified") => ({
    schemaVersion: 5,
    kind,
    id,
    status: "current",
    confidence,
  });
  const nEndpoints = Math.round(M * 0.25);
  const nCalls = o.calls ?? Math.round(M * 0.1);
  const nTables = Math.max(1, Math.round(M * 0.05));
  const nSettings = Math.round(M * 0.08);
  const nUnresolved = Math.round(M * 0.04);
  const slots = [];
  /** Endpoints by repo, for the calls into them. */
  const eps = [];
  for (let r = 0; r < N; r++) {
    const list = [];
    for (let k = 0; k < nEndpoints; k++) {
      const j = k % compsOf;
      const a = NOUNS[(r * 7 + k) % NOUNS.length];
      const b = NOUNS[(r * 3 + k * 5) % NOUNS.length];
      const method = ["GET", "POST", "PUT", "DELETE"][k % 4];
      const path = core.normalizePath(`/api/v1/${a}s/{id}/${b}-${k}`);
      list.push({
        id: `${compId(r, j)}.${method.toLowerCase()}-${a}-${b}-${k}`,
        comp: compId(r, j),
        method,
        path,
        a,
        b,
      });
    }
    eps.push(list);
  }
  for (let r = 0; r < N; r++) {
    const records = [];
    for (let j = 0; j < compsOf; j++)
      records.push({
        ...base("Component", compId(r, j)),
        evidence: [
          ev(r, `services/${compId(r, j)}/forge.yaml`, {
            source: "config",
            extractor: "component@1.3.0",
          }),
        ],
        repo: repoId(r),
        system: sysId(r),
        type: j === compsOf - 1 && r % 5 === 0 ? "spring-batch" : "spring-boot",
      });
    for (const e of eps[r])
      records.push({
        ...base("Endpoint", e.id),
        component: e.comp,
        endpointType: "rest",
        evidence: [
          ev(r, `src/main/java/forge/${cap(e.a)}${cap(e.b)}Controller.java`, {
            side: "definition",
          }),
        ],
        method: e.method,
        normalizedPath: e.path,
        pathOrTopic: e.path,
        schemaRefs: [],
      });
    // Calls out to other repos' endpoints (sync), from this repo's components.
    for (let k = 0; k < nCalls; k++) {
      const to = (r + 1 + Math.floor(rnd() * Math.max(1, N - 1))) % N;
      if (to === r && N > 1) continue;
      const e = pick(eps[to]);
      const from = compId(r, k % compsOf);
      records.push({
        ...base("Interface", core.interfaceId(from, e.comp, e.method, e.path), "inferred"),
        conflicts: [],
        direction: "outbound",
        endpoint: e.id,
        evidence: [ev(r, `src/main/java/forge/${cap(e.a)}Client.java`, { side: "caller" })],
        from,
        method: e.method,
        normalizedPath: e.path,
        sync: "sync",
        to: e.comp,
        via: "direct",
      });
    }
    // Events: each repo publishes `events` topics; `fanout` components of other repos subscribe.
    // The subscriber's repo reads the subscription (its listener), so the arrow is in its slot.
    slots.push({ r, records });
  }
  if (o.events) {
    for (let r = 0; r < N; r++)
      for (let t = 0; t < o.events; t++) {
        const noun = NOUNS[(r * 11 + t * 3) % NOUNS.length];
        const topic = `${noun}.${NOUNS[(r + t) % NOUNS.length]}.${STATES[t % STATES.length]}`;
        const pub = compId(r, t % compsOf);
        const topicId = `topic.${pad(r)}-${t}-${noun}`;
        slots[r].records.push({
          ...base("Endpoint", topicId),
          component: pub,
          endpointType: "event-topic",
          evidence: [ev(r, `topics/${topic}.yaml`, { side: "definition", source: "event-config" })],
          pathOrTopic: topic,
          schemaRefs: [],
        });
        for (let f = 0; f < o.fanout; f++) {
          const s = (r + 1 + Math.floor(rnd() * Math.max(1, N - 1))) % N;
          if (s === r && N > 1) continue;
          const sub = compId(s, Math.floor(rnd() * compsOf));
          slots[s].records.push({
            ...base("Interface", core.interfaceId(pub, sub, undefined, topic), "inferred"),
            conflicts: [],
            direction: "outbound",
            endpoint: topicId,
            evidence: [ev(s, `src/main/java/forge/${cap(noun)}Listener.java`, { side: "callee" })],
            from: pub,
            normalizedPath: topic,
            sync: "async",
            to: sub,
            via: "event-bus",
          });
        }
      }
  }
  for (const { r, records } of slots) {
    const tables = [];
    for (let k = 0; k < nTables; k++) {
      const n = NOUNS[(r + k) % NOUNS.length];
      const c = compId(r, k % compsOf);
      const id = `db-${pad(r)}.${n}-${k}`;
      tables.push(id);
      records.push({
        ...base("Table", id),
        dataStore: `db-${pad(r)}`,
        evidence: [
          ev(r, `db/migration/V${k + 1}__${n}.sql`, {
            source: "migration",
            extractor: "migrations@1.4.0",
          }),
        ],
        name: `${n}_${k}`,
        ownerComponent: c,
        readers: [c],
        tableKind: "table",
        writers: k % 2 ? [c] : [],
      });
    }
    let k = 0;
    while (records.length < M - nSettings - nUnresolved) {
      const t = tables[k % tables.length];
      records.push({
        ...base("Column", `${t}.col-${k}`),
        evidence: [
          ev(r, `db/migration/V${(k % tables.length) + 1}__t.sql`, {
            source: "migration",
            extractor: "migrations@1.4.0",
          }),
        ],
        name: `col_${k}`,
        nullable: k % 3 === 0,
        table: t,
        type: k % 2 ? "varchar(40)" : "bigint",
      });
      k++;
    }
    for (let s = 0; s < nSettings; s++) {
      const c = compId(r, s % compsOf);
      const n = NOUNS[(r * 5 + s) % NOUNS.length];
      const schedule = s < 2;
      records.push({
        ...base("Setting", `${c}.${schedule ? "schedule" : "timeout"}-${n}-${s}`),
        component: c,
        evidence: [ev(r, `services/${c}/src/main/resources/application.yml`, { source: "config" })],
        key: schedule ? `schedule.${n}-sweep-${s}` : `${n}.client.timeout-${s}`,
        settingKind: schedule ? "schedule" : "timeout",
        valueOrRef: schedule ? "0 0 2 * * *" : `${100 + s}ms`,
      });
    }
    for (let u = 0; u < nUnresolved; u++) {
      const c = compId(r, u % compsOf);
      const n = NOUNS[(r + u * 7) % NOUNS.length];
      records.push({
        ...base("Unresolved", `${c}.call.${hex(`${r}-${u}`)}`, "inferred"),
        evidence: [ev(r, `src/main/java/forge/${cap(n)}Gateway.java`, { side: "caller" })],
        owner: c,
        raw: `https://${n}.partner.example/${n}s`,
        unresolvedKind: "unknown-host",
      });
    }
  }
  return {
    profile: {
      schemaVersion: 1,
      platform: "synth",
      name: "Synthetic estate",
      systems: Array.from({ length: N }, (_, r) => ({
        id: sysId(r),
        name: `System ${cap(NOUNS[r % NOUNS.length])} ${r}`,
        boundary: "product",
        owner: `team-${pad(r)}`,
      })),
      environments: ["dev", "prod"],
    },
    manifest: {
      schemaVersion: 1,
      platform: "synth",
      repos: Array.from({ length: N }, (_, r) => ({
        id: repoId(r),
        url: `https://git.example.com/synth/${repoId(r)}.git`,
        type: "spring-boot",
        owner: `team-${pad(r)}`,
        system: sysId(r),
      })),
    },
    slots: slots.map(({ r, records }) => ({
      repo: repoId(r),
      text: readersSlotText(repoId(r), records),
    })),
  };
}

function sortRecords(records) {
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...records].sort((a, b) => cmp(a.kind, b.kind) || cmp(a.id, b.id));
}

function readersSlotText(repo, records) {
  // Dedupe by kind/id (a random call may repeat): the first stays.
  const seen = new Set();
  const out = [];
  for (const r of records) {
    const k = `${r.kind}/${r.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return (
    JSON.stringify(
      {
        slotVersion: 1,
        kind: "readers",
        repo,
        commit: COMMIT,
        status: "read",
        extractors: [
          { id: "component", version: "1.3.0" },
          { id: "migrations", version: "1.4.0" },
          { id: "spring", version: "1.2.0" },
        ],
        settings: "0".repeat(64),
        records: sortRecords(out),
      },
      null,
      2,
    ) + "\n"
  );
}

async function generate(root, o) {
  const e = estate(o, await import(CORE));
  const yaml = (v) => JSON.stringify(v, null, 2) + "\n"; // JSON is YAML
  await mkdir(join(root, "org-pack/profiles/synth"), { recursive: true });
  await writeFile(
    join(root, "org-pack/pack.yaml"),
    yaml({ schemaVersion: 1, name: "synth", version: "0.1.0", owner: "team-platform" }),
  );
  await writeFile(join(root, "org-pack/profiles/synth/profile.yaml"), yaml(e.profile));
  await writeFile(join(root, "org-pack/profiles/synth/repos.manifest.yaml"), yaml(e.manifest));
  await mkdir(join(root, "catalog/sources/readers"), { recursive: true });
  let records = 0;
  for (const s of e.slots) {
    await writeFile(join(root, "catalog/sources/readers", `${s.repo}.json`), s.text);
    records += JSON.parse(s.text).records.length;
  }
  return { repos: e.slots.length, records };
}

/** One repo's slot with one record changed and one added: a re-read that found a little more. */
async function changeOneSlot(root) {
  const path = join(root, "catalog/sources/readers", "synth-repo-00.json");
  const slot = JSON.parse(await readFile(path, "utf8"));
  const set = slot.records.find((r) => r.kind === "Setting" && r.settingKind === "timeout");
  set.valueOrRef = "999ms";
  const comp = slot.records.find((r) => r.kind === "Component");
  slot.records.push({
    schemaVersion: 5,
    kind: "Setting",
    id: `${comp.id}.timeout-bench-added`,
    status: "current",
    confidence: "verified",
    component: comp.id,
    evidence: [{ ...set.evidence[0], line: 999 }],
    key: "bench.client.timeout-added",
    settingKind: "timeout",
    valueOrRef: "250ms",
  });
  await writeFile(path, readersSlotText(slot.repo, slot.records));
}

// ------------------------------------------------------------------ one phase (a child process)

async function phase(name, root, scanner) {
  const s = await import(scanner ?? SCANNER);
  if (name === "one") await changeOneSlot(root);
  const t0 = performance.now();
  const c0 = process.cpuUsage();
  const r = await s.buildAndWrite(root, { command: "atticus catalog build" });
  const cpu = process.cpuUsage(c0);
  const wall = performance.now() - t0;
  const ru = process.resourceUsage();
  const out = {
    phase: name,
    wallS: +(wall / 1000).toFixed(2),
    cpuS: +((cpu.user + cpu.system) / 1e6).toFixed(2),
    maxRssMB: Math.round(ru.maxRSS / 1024),
    records: r.build.files.size,
    refused: r.guard.refused ? r.guard.refused.reasons : undefined,
    written: r.write?.written,
    removed: r.write?.removed,
    problems: r.build.problems.length,
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

// ------------------------------------------------------------------ the driver

async function main() {
  const o = args(process.argv.slice(2));
  if (o.phase) return phase(o.phase, o.root, o.scanner);
  const opts = {
    repos: Number(o.repos ?? 40),
    records: Number(o.records ?? 2500),
    events: Number(o.events ?? 0),
    fanout: Number(o.fanout ?? 0),
    ...(o.calls !== undefined ? { calls: Number(o.calls) } : {}),
  };
  const root = o.dir ? String(o.dir) : await mkdtemp(join(tmpdir(), "atticus-build-bench-"));
  const phases = String(o.phases ?? "cold,unchanged,one").split(",");
  const timeout = Number(o.timeout ?? 600) * 1000;
  try {
    if (phases.includes("cold")) {
      await rm(root, { recursive: true, force: true });
      await mkdir(root, { recursive: true });
      const g = await generate(root, opts);
      process.stderr.write(`estate: ${g.repos} repos, ${g.records} records in ${root}\n`);
    }
    const rows = [];
    for (const p of phases) {
      const node = [
        ...(o["cpu-prof"]
          ? [
              "--cpu-prof",
              "--cpu-prof-dir",
              join(root, ".prof"),
              "--cpu-prof-name",
              `${p}.cpuprofile`,
            ]
          : []),
        "--max-old-space-size=4096",
        fileURLToPath(import.meta.url),
        "--phase",
        p,
        "--root",
        root,
        ...(o.scanner ? ["--scanner", String(o.scanner)] : []),
      ];
      const t0 = performance.now();
      const c = spawnSync(process.execPath, node, {
        encoding: "utf8",
        timeout,
        maxBuffer: 1 << 26,
      });
      const line = (c.stdout ?? "").trim().split("\n").at(-1) ?? "";
      if (c.status !== 0 || !line.startsWith("{")) {
        rows.push({
          phase: p,
          failed: c.signal ?? c.status,
          wallS: +((performance.now() - t0) / 1000).toFixed(1),
        });
        process.stderr.write(
          `${p}: failed (${c.signal ?? c.status})\n${(c.stderr ?? "").slice(-4000)}\n`,
        );
        break;
      }
      process.stdout.write(`${line}\n`);
      rows.push(JSON.parse(line));
    }
    console.table(rows);
  } finally {
    if (!o.keep) await rm(root, { recursive: true, force: true });
  }
}

await main();
