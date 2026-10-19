import { readdir, readFile, stat } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import {
  API_VERSION,
  catalogDirOf,
  inputsDirOf,
  isAdopted,
  loadOrgPack,
  logFileOf,
  orgPackDirOf,
  redactText,
  SCHEMA_VERSION,
  writeFileAtomic,
} from "@maycombhq/core";
import { changeStore } from "@maycombhq/changes";
import { loadRepos } from "@maycombhq/workspace";
import type { Output } from "./commands.js";
import { doctorChecks, type DoctorDeps } from "./doctor.js";
import { setupSteps } from "./baseline-commands.js";
import { VERSION } from "./version.js";

/**
 * `atticus support bundle` (ADR 0050): what someone helping with a problem needs, in one zip,
 * written on this machine and sent nowhere. It holds versions, the machine checks, the setup
 * checklist, org-pack problems, counts (never names) and the redacted log. No catalog record,
 * change, org-pack file or document is in it. A person reads it before it leaves.
 */

export interface BundleFile {
  name: string;
  text: string;
}

const LOG_LINES = 2000;

/** Paths and the person's name replaced, secrets masked: the same redaction as the log. */
function scrub(text: string, root: string): string {
  const variants = [root, root.replace(/\\/g, "/"), root.replace(/\//g, "\\")];
  let out = text;
  for (const v of variants) if (v.length > 3) out = out.split(v).join("<metarepo>");
  return redactText(out);
}

async function countFiles(dir: string): Promise<number> {
  try {
    return (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile())
      .length;
  } catch {
    return 0;
  }
}

async function lastLines(file: string, n: number): Promise<string | undefined> {
  try {
    const text = await readFile(file, "utf8");
    return text
      .split("\n")
      .slice(-n - 1)
      .join("\n");
  } catch {
    return undefined;
  }
}

export async function bundleFiles(root: string, deps: DoctorDeps = {}): Promise<BundleFile[]> {
  const op = await loadOrgPack(orgPackDirOf(root));
  const doctor = await doctorChecks(root, deps);
  const setup = await setupSteps(root, { doctor });
  const kinds: Record<string, number> = {};
  for (const sub of ["generated", "curated"]) {
    const dir = join(catalogDirOf(root), sub);
    for (const k of await readdir(dir).catch(() => [] as string[])) {
      if (!(await stat(join(dir, k)).catch(() => undefined))?.isDirectory()) continue;
      kinds[`${sub}/${k}`] = await countFiles(join(dir, k));
    }
  }
  const states: Record<string, number> = {};
  for (const c of await changeStore(root)
    .list()
    .catch(() => []))
    states[c.state] = (states[c.state] ?? 0) + 1;
  const repos = await loadRepos(root).catch(() => []);
  const about = {
    atticus: VERSION,
    catalogSchema: SCHEMA_VERSION,
    api: API_VERSION,
    node: process.versions.node,
    os: { platform: platform(), release: release(), arch: arch() },
    layout: isAdopted(root) ? "adopted" : "metarepo",
    ai: op.runtime.ai,
    modes: op.runtime.modes,
    adapters: Object.fromEntries(
      Object.entries(op.runtime.adapters)
        .filter(([, a]) => a)
        .map(([k, a]) => [k, a!.type]),
    ),
    createdAt: new Date().toISOString(),
  };
  const counts = {
    records: kinds,
    changes: states,
    repos: repos.length,
    inputs: await countFiles(inputsDirOf(root)),
  };
  const files: BundleFile[] = [
    {
      name: "README.txt",
      text: [
        "Atticus support bundle",
        "",
        "Written by `atticus support bundle` on this machine. Nothing was sent anywhere.",
        "",
        "What is in it:",
        "  about.json      versions, operating system, layout, AI mode and adapter types",
        "  doctor.json     the machine checks (atticus doctor)",
        "  setup.json      the setup checklist",
        "  org-pack.json   problems loading the org pack (file and message)",
        "  counts.json     how many records, changes, repos and input files: numbers, never names",
        "  atticus.log     the last lines of the local log, redacted",
        "",
        "What is not in it: catalog records, changes, org-pack files, documents, code, tokens",
        "or passwords. Paths start at <metarepo>, and your home folder and user name are hidden.",
        "",
        "Read every file before you send this outside your organisation. Error messages can",
        "name a system, change or file of yours; remove anything you can't share.",
        "",
      ].join("\n"),
    },
    { name: "about.json", text: JSON.stringify(about, null, 2) },
    { name: "doctor.json", text: JSON.stringify(doctor, null, 2) },
    { name: "setup.json", text: JSON.stringify(setup, null, 2) },
    { name: "org-pack.json", text: JSON.stringify(op.problems, null, 2) },
    { name: "counts.json", text: JSON.stringify(counts, null, 2) },
  ];
  const log = await lastLines(logFileOf(root), LOG_LINES);
  if (log !== undefined) files.push({ name: "atticus.log", text: log });
  return files.map((f) => ({ name: f.name, text: scrub(f.text, root) }));
}

// ------------------------------------------------------------------ zip

/** A plain zip (deflate), enough for a handful of text files; every unzip tool reads it. */
export function zip(files: BundleFile[], at = new Date()): Buffer {
  const dosTime = (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1);
  const dosDate = ((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const data = Buffer.from(f.text, "utf8");
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** atticus support bundle [--out file.zip] [--json] */
export async function supportBundleCommand(
  root: string,
  o: { out?: string; json?: boolean; now?: Date },
  io: Output,
  deps: DoctorDeps = {},
): Promise<number> {
  const now = o.now ?? new Date();
  const files = await bundleFiles(root, deps);
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const out = resolve(o.out ?? join(root, ".atticus", "logs", `atticus-support-${stamp}.zip`));
  await writeFileAtomic(out, zip(files, now));
  if (o.json) io.out(JSON.stringify({ file: out, files: files.map((f) => f.name) }, null, 2));
  else {
    io.out(`Wrote ${out} (${files.length} files, nothing sent anywhere):`);
    for (const f of files) io.out(`  ${f.name}`);
    io.out("Read every file before you send it outside your organisation (README.txt says why).");
  }
  return 0;
}
