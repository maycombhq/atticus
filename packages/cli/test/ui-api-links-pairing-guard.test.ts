import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { keepCatalogsInMemory } from "@maycombhq/scanner";
import { startServer, type RunningServer } from "@maycombhq/server";
import { extendUiRoutes } from "../src/ui-commands.js";
import { verifyCommand } from "../src/verify-commands.js";
import { verifyConfirmed } from "./seed-slots.js";

/**
 * Beta.28.1 (field hunt G1): a person's pairing on a small repo never trips the large-removal
 * guard. On the invented estate of `fixtures/gateway-facts/token-host/` the proxy's four calls
 * are loose ends (Unresolved) of a repo of 18 records; paired from Connect to…, the next Apply
 * joins each, which removes the four loose ends. That is the pairing's own result, not a loss:
 * each removal says the arrow it joins now, none counts toward the limit, and the Apply writes
 * without `--allow-removals`. The pairing's preview says whether the Apply will need confirming.
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "token-host");
const PROXY = "forge_instruments_1-0";
const SERVICE = "forge-instruments";
const COMMIT: Record<string, string> = { [PROXY]: "8a1c0de", [SERVICE]: "5e1f00d" };
const MEANT: Record<string, string> = {
  "call.get.instruments-ping": "entry.get.instruments-ping",
  "call.post.instruments": "entry.post.instruments",
  "call.get.instruments-id": "entry.get.instruments-instrumentid",
  "call.post.instruments-id-status": "entry.post.instruments-instrumentid-status",
};
const AT = new Date("2026-11-13T10:00:00.000Z");

let root: string;
let srv: RunningServer;
const opts = (repo: string) => ({
  commit: COMMIT[repo]!,
  dir: join(root, "workspace", repo),
  write: true,
  now: () => AT,
});
const call = async (path: string, method = "GET", body?: unknown) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: {
      "X-Atticus-Token": srv.token,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "atticus-pairing-guard-"));
  cpSync(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  mkdirSync(join(root, "facts"), { recursive: true });
  for (const r of Object.keys(COMMIT)) {
    cpSync(join(FIX, "repos", r), join(root, "workspace", r), { recursive: true });
    writeFileSync(
      join(root, "facts", `${r}.jsonl`),
      readFileSync(join(FIX, "facts", `${r}.jsonl`), "utf8"),
    );
  }
  // The first reads take the readers' place (removals a person confirms once, as in the field).
  for (const r of Object.keys(COMMIT)) {
    const out: string[] = [];
    const code = await verifyConfirmed(root, r, opts(r), {
      out: (l) => out.push(l),
      err: (l) => out.push(l),
    });
    expect(code, out.join("\n")).toBe(0);
  }
  keepCatalogsInMemory(true);
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    version: "1.0.0",
    extend: (r, ctx) => extendUiRoutes(r, ctx),
  });
}, 300_000);
afterAll(async () => {
  keepCatalogsInMemory(false);
  await srv?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("a person's pairing and the removal guard (field hunt G1)", () => {
  const pairs = Object.entries(MEANT).map(([c, a]) => ({ call: c, api: a }));

  it("previews the pairing with its removals, and says the Apply needs no confirm", async () => {
    const p = await call("/api/links/connect", "POST", {
      from: PROXY,
      to: { repo: SERVICE },
      pairs,
      preview: true,
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const v = Api.VerifyPreviewView.parse(Api.ConnectLinksResult.parse(p.body).preview);
    expect(v.preview?.catalog?.removed).toBe(4);
    expect(v.preview?.confirm).toBeUndefined();
  });

  it("says in the preview when the Apply will wait for a confirm, and with what count", async () => {
    // Two of the proxy's entries and their calls dropped from its facts: the Apply would remove
    // their endpoints and loose ends too, which no pairing joins.
    const file = join(root, "facts", `${PROXY}.jsonl`);
    const was = readFileSync(file, "utf8");
    writeFileSync(
      file,
      was
        .split("\n")
        .filter((l) => !l.includes("instruments-id"))
        .join("\n"),
    );
    try {
      const p = await call("/api/links/connect", "POST", {
        from: PROXY,
        to: { repo: SERVICE },
        pairs: pairs.filter((x) => !x.call.includes("instruments-id")),
        preview: true,
      });
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      const v = Api.ConnectLinksResult.parse(p.body);
      const pv = Api.VerifyPreviewView.parse(v.preview);
      const confirm = pv.preview?.confirm;
      expect(confirm, JSON.stringify(pv.preview)).toBeDefined();
      expect(confirm!.removals).toBeGreaterThan(2);
      expect(confirm!.command).toBe(
        `atticus verify ${PROXY} --write --allow-removals ${confirm!.removals}`,
      );
    } finally {
      writeFileSync(file, was);
    }
  });

  it("over the limit, the preview's confirm is what Apply asks, and its command writes", async () => {
    const file = join(root, "facts", `${PROXY}.jsonl`);
    const was = readFileSync(file, "utf8");
    writeFileSync(
      file,
      was
        .split("\n")
        .filter((l) => !l.includes("instruments-id"))
        .join("\n"),
    );
    try {
      const some = pairs.filter((x) => !x.call.includes("instruments-id"));
      const p = await call("/api/links/connect", "POST", {
        from: PROXY,
        to: { repo: SERVICE },
        pairs: some,
        preview: true,
      });
      const pv = Api.VerifyPreviewView.parse(Api.ConnectLinksResult.parse(p.body).preview).preview;
      const out: string[] = [];
      const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(l) };
      // The pairing as a preview's extra: on file only for this check, then taken back.
      const corr = join(root, "facts", `${PROXY}.corrections.jsonl`);
      const lines = Api.ConnectLinksResult.parse(p.body).lines;
      writeFileSync(corr, lines.map((l) => `${l}\n`).join(""));
      try {
        expect(await verifyCommand(root, PROXY, { ...opts(PROXY), write: false }, io)).toBe(0);
        const refused = await verifyCommand(root, PROXY, opts(PROXY), io);
        expect(refused).not.toBe(0);
        const n = Number(/--allow-removals (\d+)\./.exec(out.join("\n"))?.[1]);
        expect(pv?.confirm?.removals).toBe(n);
        expect(pv?.confirm?.command).toBe(`atticus verify ${PROXY} --write --allow-removals ${n}`);
      } finally {
        rmSync(corr, { force: true });
      }
    } finally {
      writeFileSync(file, was);
    }
  });

  it("says Apply will stop for hand edits, and asks no removal confirm Apply wouldn't", async () => {
    const dir = join(root, "catalog", "generated", "endpoint");
    const one = readdirSync(dir).filter((n) => n.endsWith(".yaml"))[0]!;
    const id = one.replace(/\.yaml$/, "");
    const text = readFileSync(join(dir, one), "utf8");
    const made = ["-hand-a", "-hand-b", "-hand-c"].map((x) => join(dir, `${id}${x}.yaml`));
    for (const [i, f] of made.entries())
      writeFileSync(
        f,
        text.replace(`id: ${id}`, `id: ${id}${["-hand-a", "-hand-b", "-hand-c"][i]}`),
      );
    try {
      const p = await call("/api/links/connect", "POST", {
        from: PROXY,
        to: { repo: SERVICE },
        pairs,
        preview: true,
      });
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      const pv = Api.VerifyPreviewView.parse(Api.ConnectLinksResult.parse(p.body).preview).preview;
      // Hand-added files aren't the build's to remove: no removals to confirm, three edits.
      expect(pv?.confirm?.removals).toBeUndefined();
      expect(pv?.confirm?.edits).toBe(3);
      expect(pv?.confirm?.command).toBe(`atticus verify ${PROXY} --write --discard-edits 3`);
    } finally {
      for (const f of made) rmSync(f, { force: true });
    }
  });

  it("writes the pairing's Apply without --allow-removals, each loose end joined now", async () => {
    const w = await call("/api/links/connect", "POST", {
      from: PROXY,
      to: { repo: SERVICE },
      pairs,
    });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    const out: string[] = [];
    const code = await verifyCommand(root, PROXY, opts(PROXY), {
      out: (l) => out.push(l),
      err: (l) => out.push(`ERR ${l}`),
    });
    const said = out.join("\n");
    expect(code, said).toBe(0);
    expect(said).not.toContain("--allow-removals");
    const joined = said
      .split("\n")
      .filter((l) => /removed? Unresolved\/.*joined now \(Interface\//.test(l));
    expect(joined.length, said).toBe(4);
  });
});
