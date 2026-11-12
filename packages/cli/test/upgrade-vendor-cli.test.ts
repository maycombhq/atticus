import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { interfaceId, parseRecord, serializeRecord, type CatalogRecord } from "@maycombhq/core";
import { main } from "../src/main.js";
import { verifyCommand } from "../src/verify-commands.js";

/**
 * The review of beta.27: beta.27's merge lands the names a call gives a vendor no estate repo
 * belongs to on the vendor's system, where beta.26 inferred a component named by the host's first
 * label (`northwind-pay-api`) and drew the arrow to it. `atticus upgrade --yes` of a beta.26
 * catalog must stay lossless (ADR 0195 point 6): its first build is byte for byte the catalog
 * before, the beta.26 arrow and component included. Only the next `verify --write` of the caller
 * moves the arrow to the vendor system, listed with the build's removals and their reason. On the
 * invented Forge estate of fixtures/gateway-facts/vendor-spec (Northwind Pay an invented vendor).
 * Files only, no network.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "vendor-spec");
const COMMIT: Record<string, string> = {
  "northwind_accounts_1-0": "8888aaa",
  "forge-onboarding": "9999bbb",
};
const PROXY = "northwind_accounts_1-0";
const AT = new Date("2026-11-12T10:00:00.000Z");
/** The component beta.26 inferred for the vendor from its host's first label. */
const BY_LABEL = "northwind-pay-api";

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const capture = () => {
  const lines: string[] = [];
  return { lines, io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) } };
};
const run = async (args: string[]) => {
  const c = capture();
  const code = await main(args, c.io);
  return { code, said: c.lines.join("\n") };
};
const verify = async (root: string, repo: string, allowRemovals?: number) => {
  const c = capture();
  const code = await verifyCommand(
    root,
    repo,
    {
      commit: COMMIT[repo]!,
      dir: join(root, "workspace", repo),
      write: true,
      now: () => AT,
      ...(allowRemovals !== undefined ? { allowRemovals } : {}),
    },
    c.io,
  );
  return { code, said: c.lines.join("\n") };
};

function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).split("\\").join("/")] = readFileSync(p, "utf8");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

type Iface = Extract<CatalogRecord, { kind: "Interface" }>;
const record = (text: string): CatalogRecord => {
  const r = parseRecord(parse(text));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.record;
};

/**
 * A beta.26 metarepo: both repos verified and written, then the catalog given the shape beta.26
 * wrote (the proxy's balances arrow to the component it inferred from the host's label, that
 * component in the vendor's system), and no catalog/sources/ (beta.26 had none).
 */
async function beta26(): Promise<{ root: string; was: Iface; arrow: Iface }> {
  const root = mkdtempSync(join(tmpdir(), "atticus-upgrade-vendor-"));
  temps.push(root);
  cpSync(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  cpSync(join(FIX, "inputs"), join(root, "inputs"), { recursive: true });
  mkdirSync(join(root, "facts"), { recursive: true });
  for (const r of Object.keys(COMMIT)) {
    cpSync(join(FIX, "repos", r), join(root, "workspace", r), { recursive: true });
    cpSync(join(FIX, "facts", `${r}.jsonl`), join(root, "facts", `${r}.jsonl`));
  }
  for (const r of Object.keys(COMMIT)) {
    const v = await verify(root, r);
    expect(v.code, v.said).toBe(0);
  }
  rmSync(join(root, "catalog", "sources"), { recursive: true, force: true });
  rmSync(join(root, ".index", "build-undo"), { recursive: true, force: true });
  rmSync(join(root, ".atticus", "state", "build-undo"), { recursive: true, force: true });
  const dir = join(root, "catalog", "generated", "interface");
  const name = readdirSync(dir).find((n) => {
    const r = record(readFileSync(join(dir, n), "utf8"));
    return (
      r.kind === "Interface" &&
      r.from === "northwind-accounts-proxy" &&
      r.normalizedPath === "/api/v1/accounts/balances"
    );
  })!;
  expect(name).toBeDefined();
  const was = record(readFileSync(join(dir, name), "utf8")) as Iface;
  expect(was.to).toBe("northwind-pay");
  const arrow = {
    ...was,
    to: BY_LABEL,
    id: interfaceId(was.from, BY_LABEL, was.method, was.normalizedPath!),
  } as Iface;
  unlinkSync(join(dir, name));
  writeFileSync(join(dir, `${arrow.id}.yaml`), serializeRecord(arrow));
  const component = record(
    [
      "schemaVersion: 3",
      "kind: Component",
      `id: ${BY_LABEL}`,
      "status: current",
      "confidence: inferred",
      "system: northwind-pay",
      "type: service",
      "evidence:",
      `  - ${JSON.stringify(was.evidence[0])}`,
      "",
    ].join("\n"),
  );
  mkdirSync(join(root, "catalog", "generated", "component"), { recursive: true });
  writeFileSync(
    join(root, "catalog", "generated", "component", `${BY_LABEL}.yaml`),
    serializeRecord(component),
  );
  return { root, was, arrow };
}

describe("upgrading a beta.26 catalog with an arrow to an inferred vendor component (the review of beta.27)", () => {
  it("adopts it byte for byte; the caller's next verify --write moves the arrow to the vendor system, said as a removal", async () => {
    const { root, was, arrow } = await beta26();
    const before = files(join(root, "catalog", "generated"));
    expect(before[`interface/${arrow.id}.yaml`]).toBeDefined();
    expect(before[`component/${BY_LABEL}.yaml`]).toBeDefined();

    // The dry run says the first build changes nothing, and --yes writes the catalog as it was.
    const dry = await run(["upgrade", "--root", root]);
    expect(dry.code, dry.said).toBe(0);
    expect(dry.said).toMatch(/The first build changes nothing/);
    const yes = await run(["upgrade", "--root", root, "--yes"]);
    expect(yes.code, yes.said).toBe(0);
    expect(files(join(root, "catalog", "generated"))).toEqual(before);
    const check = await run(["catalog", "build", "--root", root, "--check"]);
    expect(check.code, check.said).toBe(0);

    // The next verify --write of the proxy: its facts replace its legacy slot, and beta.27's
    // merge draws the arrow to the vendor's system. The beta.26 arrow and the inferred component
    // are removals the build lists, with why, waiting for confirmation when they're many.
    let v = await verify(root, PROXY);
    const n = /--allow-removals (\d+)\./.exec(v.said)?.[1];
    if (v.code !== 0 && n) v = await verify(root, PROXY, Number(n));
    expect(v.code, v.said).toBe(0);
    const after = files(join(root, "catalog", "generated"));
    expect(after[`interface/${arrow.id}.yaml`]).toBeUndefined();
    expect(after[`component/${BY_LABEL}.yaml`]).toBeUndefined();
    expect(after[`interface/${was.id}.yaml`]).toBeDefined();
    expect((record(after[`interface/${was.id}.yaml`]!) as Iface).to).toBe("northwind-pay");
    // Said: each removal with why, and the arrow's move in the links.
    const why = `${PROXY} is built from its facts snapshot now`;
    expect(v.said).toContain(`removed Interface/${arrow.id}: ${why}`);
    expect(v.said).toContain(`removed Component/${BY_LABEL}: ${why}`);
    expect(v.said).toContain(
      "+ northwind-accounts-proxy → northwind-pay GET /api/v1/accounts/balances",
    );
    expect(v.said).toContain(
      `- northwind-accounts-proxy → ${BY_LABEL} GET /api/v1/accounts/balances`,
    );
  }, 240_000);
});
