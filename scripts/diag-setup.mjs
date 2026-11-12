// TEMPORARY (diag/win24 only): timing instrumentation for the Windows + Node 24 stall. Loaded as a
// Vitest setup file when ATTICUS_DIAG=1. Writes lines to ATTICUS_DIAG_FILE.
import childProcess, { ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { Session } from "node:inspector";
import os from "node:os";
import { afterEach, beforeEach } from "vitest";

const G = globalThis;
const FILE = process.env.ATTICUS_DIAG_FILE || "atticus-diag.log";
const append = fs.appendFileSync;
const now = () => performance.now();
const D = (G.__atticusDiag ??= {
  test: "(none)",
  testStart: 0,
  children: new Set(),
  fsPending: new Set(),
  fetches: new Set(),
  agg: new Map(),
  profiled: false,
  reported: 0,
  listed: 0,
});

/** Machine CPU busy share since the last mark (all cores), and this worker's CPU ms. */
function cpuMark() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  const u = process.cpuUsage();
  return { idle, total, self: (u.user + u.system) / 1000, wall: performance.now() };
}
function cpuSince(m) {
  if (!m) return "";
  const n = cpuMark();
  const busy = n.total - m.total ? 1 - (n.idle - m.idle) / (n.total - m.total) : 0;
  return `machineCpu=${(busy * 100).toFixed(0)}% workerCpu=${(n.self - m.self).toFixed(0)}ms/${(n.wall - m.wall).toFixed(0)}ms freeMem=${(os.freemem() / 2 ** 20).toFixed(0)}MB`;
}

const PS = [
  "Get-CimInstance Win32_Process | ForEach-Object {",
  " $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue;",
  ' $c = "$($_.CommandLine)";',
  " [pscustomobject]@{ Id=$_.ProcessId; Parent=$_.ParentProcessId; Cpu=[math]::Round($p.CPU,1);",
  " WsMB=[math]::Round($_.WorkingSetSize/1MB); Name=$_.Name; Cmd=$c.Substring(0, [math]::Min(170, $c.Length)) } }",
  " | Sort-Object Cpu -Descending | Select-Object -First 30 | Format-Table -AutoSize | Out-String -Width 320",
].join("");
function listProcesses(why) {
  if (process.platform !== "win32") return;
  const t0 = now();
  childProcess.execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", PS],
    { windowsHide: true, timeout: 60000, maxBuffer: 8 * 2 ** 20 },
    (err, out) => log(`  PROCESSES ${why} (${(now() - t0).toFixed(0)}ms${err ? " " + err.message : ""})\n${out}`),
  );
}

function log(line) {
  try {
    append(FILE, `[diag ${process.pid} ${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* ignore */
  }
}
function where() {
  const lim = Error.stackTraceLimit;
  Error.stackTraceLimit = 40;
  const s = new Error().stack ?? "";
  Error.stackTraceLimit = lim;
  return s
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => /packages[\\/]/.test(l) && !/diag-setup/.test(l) && !/node_modules/.test(l))
    .slice(0, 5)
    .map((l) => l.replace(/^at /, "").replace(/.*[\\/]packages[\\/]/, "pk/").replace(/\)$/, ""))
    .join(" < ");
}
function add(cat, key, ms) {
  const k = `${cat}|${key}`;
  const a = D.agg.get(k) ?? { n: 0, ms: 0, max: 0 };
  a.n++;
  a.ms += ms;
  a.max = Math.max(a.max, ms);
  D.agg.set(k, a);
}
const short = (s, n = 160) => (s.length > n ? s.slice(0, n) + "…" : s);

if (process.env.ATTICUS_DIAG === "1" && !G.__atticusDiagPatched) {
  G.__atticusDiagPatched = true;
  log(`worker start node ${process.version} ${process.platform} argv=${process.argv.slice(1, 3).join(" ")}`);

  // ---------------------------------------------------------- child processes (async)
  const origSpawn = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function (options) {
    const t0 = now();
    const file = String(options?.file ?? "?");
    const args = (options?.args ?? []).slice(1).map(String);
    const base = file.split(/[\\/]/).pop();
    const label = short(
      `${base} ${args
        .map((a) => (a.length > 60 ? "…" + a.slice(-40) : a))
        .join(" ")}`,
      200,
    );
    const key = base === "node.exe" || base === "node" ? `${base} ${(args[0] ?? "").split(/[\\/]/).pop()} ${args[1] ?? ""}` : `${base} ${args.filter((a) => !a.startsWith("-") && !a.includes("=")).slice(0, 2).join(" ")}`;
    const info = {
      label,
      key,
      t0,
      test: D.test,
      stack: where(),
      cwd: String(options?.cwd ?? ""),
      shell: !!options?.shell,
      detached: !!options?.detached,
      spawned: undefined,
      exited: undefined,
      child: this,
    };
    D.children.add(info);
    this.once("spawn", () => (info.spawned = now() - t0));
    this.once("exit", (code, sig) => {
      info.exited = now() - t0;
      info.code = code ?? sig;
    });
    const end = (how) => {
      if (!D.children.has(info)) return;
      D.children.delete(info);
      const total = now() - t0;
      add("child", key, total);
      const gap = info.exited !== undefined ? total - info.exited : -1;
      if (total > 1500 || (info.spawned ?? 0) > 500 || gap > 500)
        log(
          `CHILD slow ${total.toFixed(0)}ms spawn=${info.spawned?.toFixed(0)} exit=${info.exited?.toFixed(0)} close-gap=${gap.toFixed(0)} code=${info.code} how=${how} shell=${info.shell} det=${info.detached} pid=${this.pid} test="${info.test}" cmd=[${label}] cwd=${short(info.cwd, 100)} at ${info.stack}`,
        );
    };
    this.once("close", () => end("close"));
    this.once("error", (e) => end(`error:${e.code ?? e.message}`));
    try {
      return origSpawn.call(this, options);
    } catch (e) {
      end(`throw:${e.code ?? e.message}`);
      throw e;
    }
  };

  // ---------------------------------------------------------- child processes (sync)
  for (const name of ["spawnSync", "execFileSync", "execSync"]) {
    const orig = childProcess[name];
    childProcess[name] = function (...a) {
      const t0 = now();
      try {
        return orig.apply(this, a);
      } finally {
        const ms = now() - t0;
        const cmd = short(`${a[0]} ${Array.isArray(a[1]) ? a[1].join(" ") : ""}`, 160);
        const key = `${name} ${String(a[0]).split(/[\\/]/).pop()} ${Array.isArray(a[1]) ? a[1].filter((x) => !String(x).startsWith("-") && !String(x).includes("=")).slice(0, 1).join(" ") : ""}`;
        add("sync", key, ms);
        if (ms > 1500) log(`SYNC slow ${ms.toFixed(0)}ms ${name} test="${D.test}" cmd=[${cmd}] at ${where()}`);
      }
    };
  }

  // ---------------------------------------------------------- fs/promises
  for (const name of Object.keys(fsp)) {
    const orig = fsp[name];
    if (typeof orig !== "function" || name === "constants" || name === "watch") continue;
    fsp[name] = function (...a) {
      const t0 = now();
      const rec = { name, path: short(String(a[0]), 120), t0, test: D.test };
      D.fsPending.add(rec);
      const fin = () => {
        D.fsPending.delete(rec);
        const ms = now() - t0;
        add("fsp", name, ms);
        if (ms > 1000)
          log(`FSP slow ${ms.toFixed(0)}ms ${name}(${rec.path}${a[1] && typeof a[1] === "object" ? " " + short(JSON.stringify(a[1]), 80) : ""}) test="${D.test}" at ${where()}`);
      };
      let p;
      try {
        p = orig.apply(this, a);
      } catch (e) {
        fin();
        throw e;
      }
      if (p && typeof p.then === "function") p.then(fin, fin);
      else fin();
      return p;
    };
  }
  // ---------------------------------------------------------- some sync fs
  for (const name of ["rmSync", "cpSync", "renameSync", "readdirSync", "statSync", "lstatSync", "existsSync", "readFileSync", "writeFileSync", "mkdirSync", "realpathSync", "openSync", "copyFileSync", "rmdirSync", "unlinkSync"]) {
    const orig = fs[name];
    fs[name] = function (...a) {
      const t0 = now();
      try {
        return orig.apply(this, a);
      } finally {
        const ms = now() - t0;
        add("fssync", name, ms);
        if (ms > 1000) log(`FSSYNC slow ${ms.toFixed(0)}ms ${name}(${short(String(a[0]), 120)}) test="${D.test}" at ${where()}`);
      }
    };
  }
  syncBuiltinESMExports();

  // ---------------------------------------------------------- fetch
  const origFetch = G.fetch;
  G.fetch = async function (input, init) {
    const t0 = now();
    const url = short(String(input?.url ?? input), 120);
    const rec = { url, t0, test: D.test, method: init?.method ?? "GET" };
    D.fetches.add(rec);
    try {
      return await origFetch.call(this, input, init);
    } finally {
      D.fetches.delete(rec);
      const ms = now() - t0;
      add("fetch", `${rec.method} ${url.replace(/^http:\/\/127\.0\.0\.1:\d+/, "").replace(/run-[0-9a-z-]+/, "run-*")}`, ms);
      if (ms > 1000) log(`FETCH slow ${ms.toFixed(0)}ms ${rec.method} ${url} test="${D.test}"`);
    }
  };

  // ---------------------------------------------------------- long timers (sleeps, polls)
  const origSetTimeout = G.setTimeout;
  G.setTimeout = function (fn, ms, ...rest) {
    if (typeof ms === "number" && ms >= 1000 && D.test !== "(none)") {
      const w = where();
      if (w) {
        add("timer", `${ms}ms ${w.split(" < ")[0]}`, 0);
      }
    }
    return origSetTimeout.call(this, fn, ms, ...rest);
  };

  // ---------------------------------------------------------- event-loop lag + hang reporter
  let last = now();
  const lag = setInterval(() => {
    const t = now();
    const gap = t - last - 100;
    last = t;
    if (gap > 1000) {
      add("loop", "blocked", gap);
      log(`LOOP blocked ${gap.toFixed(0)}ms test="${D.test}"`);
    }
    if (D.test !== "(none)") {
      const age = t - D.testStart;
      if (age > 20000 && t - D.reported > 15000) {
        D.reported = t;
        report(age);
      }
    }
  }, 100);
  lag.unref();

  function report(age) {
    log(`HANG test="${D.test}" running ${(age / 1000).toFixed(0)}s ${cpuSince(D.hangMark ?? D.cpu)}`);
    D.hangMark = cpuMark();
    if (now() - D.listed > 60000) {
      D.listed = now();
      listProcesses(`for test="${D.test}"`);
    }
    for (const c of D.children)
      log(`  pending child ${(now() - c.t0).toFixed(0)}ms spawned=${c.spawned?.toFixed(0)} exited=${c.exited?.toFixed(0)} pid=${c.child.pid} cmd=[${c.label}] cwd=${short(c.cwd, 100)} at ${c.stack}`);
    for (const f of D.fsPending)
      if (now() - f.t0 > 500) log(`  pending fsp ${(now() - f.t0).toFixed(0)}ms ${f.name}(${f.path})`);
    for (const f of D.fetches) log(`  pending fetch ${(now() - f.t0).toFixed(0)}ms ${f.method} ${f.url}`);
    try {
      const r = process.getActiveResourcesInfo();
      const counts = {};
      for (const x of r) counts[x] = (counts[x] ?? 0) + 1;
      log(`  active resources ${JSON.stringify(counts)}`);
    } catch {
      /* ignore */
    }
    if (!D.profiled) {
      D.profiled = true;
      profile(4000);
    }
  }

  function profile(ms) {
    try {
      const s = new Session();
      s.connect();
      s.post("Profiler.enable", () =>
        s.post("Profiler.start", () =>
          origSetTimeout(() => {
            s.post("Profiler.stop", (err, res) => {
              s.disconnect();
              if (err || !res) return log(`  profile failed ${err}`);
              const p = res.profile;
              const self = new Map();
              const dt = (p.endTime - p.startTime) / Math.max(p.samples.length, 1) / 1000;
              const byId = new Map(p.nodes.map((n) => [n.id, n]));
              for (const id of p.samples) {
                const n = byId.get(id);
                const cf = n.callFrame;
                const k = `${cf.functionName || "(anon)"} ${String(cf.url).split(/[\\/]/).slice(-2).join("/")}:${cf.lineNumber + 1}`;
                self.set(k, (self.get(k) ?? 0) + dt);
              }
              const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
              log(`  profile ${ms}ms samples=${p.samples.length}: ${top.map(([k, v]) => `${v.toFixed(0)}ms ${k}`).join(" | ")}`);
            });
          }, ms),
        ),
      );
    } catch (e) {
      log(`  profile error ${e}`);
    }
  }
}

if (process.env.ATTICUS_DIAG === "1") {
  beforeEach((ctx) => {
    D.test = ctx.task?.name ?? "?";
    D.testStart = now();
    D.agg = new Map();
    D.profiled = false;
    D.reported = 0;
    D.cpu = cpuMark();
    D.hangMark = undefined;
  });
  afterEach(() => {
    const ms = now() - D.testStart;
    if (ms > Number(process.env.ATTICUS_DIAG_MIN ?? 2500)) {
      const rows = [...D.agg.entries()]
        .filter(([k, v]) => v.ms > 200 || k.startsWith("timer") || k.startsWith("child"))
        .sort((a, b) => b[1].ms - a[1].ms)
        .slice(0, 25)
        .map(([k, v]) => `${k} n=${v.n} sum=${v.ms.toFixed(0)} max=${v.max.toFixed(0)}`);
      log(`TEST ${ms.toFixed(0)}ms "${D.test}" ${cpuSince(D.cpu)} :: ${rows.join(" ;; ")}`);
      for (const c of D.children)
        log(`  still running child ${(now() - c.t0).toFixed(0)}ms exited=${c.exited?.toFixed(0)} cmd=[${c.label}]`);
    }
    D.test = "(none)";
  });
}
