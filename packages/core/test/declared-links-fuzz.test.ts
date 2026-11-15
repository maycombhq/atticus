import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { isMap, isSeq, parseDocument, visit } from "yaml";
import { declaredOf, declareLink, DeclareError, keepUntouchedLines } from "../src/index.js";
import { Profile } from "../src/schema/orgpack.js";

/**
 * The re-review of beta.28.1's G5: a declaration keeps the lines it doesn't touch only where
 * that never changes what the profile says, nor its comments, nor where they sit. Seeded random
 * profiles (the same every run): comments of every shape, quoted keys with colons, anchors,
 * folded and literal scalars, flow and block lists, directives, CRLF, several documents.
 */
const strictJs = (t: string) => {
  const d = parseDocument(t, { uniqueKeys: true });
  return d.errors.length ? { errors: d.errors.map((e) => e.code) } : d.toJS();
};
const comments = (t: string) => {
  const d = parseDocument(t);
  const out: string[] = [];
  if (d.commentBefore) out.push(`doc-before:${d.commentBefore}`);
  if (d.comment) out.push(`doc:${d.comment}`);
  visit(d, (_k, n) => {
    const x = n as { comment?: string | null; commentBefore?: string | null };
    if (x.commentBefore) out.push(`before:${x.commentBefore}`);
    if (x.comment) out.push(`on:${x.comment}`);
  });
  return out.sort();
};
const comments2 = (t: string) => {
  const lines = comments(t)
    .flatMap((c) => c.replace(/^(doc-before|doc|before|on):/, "").split("\n"))
    .map((x) => x.trim())
    .filter(Boolean)
    .sort();
  const d = parseDocument(t);
  const prov: string[] = [];
  for (const sys of (d.get("systems") as { items: unknown[] }).items as never[]) {
    const m = sys as { get: (k: string) => unknown };
    const calls = m.get("calls") as { items?: { get: (k: string) => unknown; comment?: string }[] };
    for (const c of calls?.items ?? [])
      prov.push(
        `${String(m.get("id"))} ${String(c.get("route"))} ${/declared by (\S+)/.exec(c.comment ?? "")?.[1] ?? "-"}`,
      );
  }
  return [...lines, "|", ...prov.sort()];
};
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
/** A draw of its own (each call draws again, so an else-if on it is a second chance). */
const chance = (r: () => number, p: number) => r() < p;
const OPTS = { lineWidth: 0, flowCollectionPadding: true } as const;

function profileOf(r: () => number): string {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const sc = (v: string) => pick([v, `'${v}'`, `"${v}"`]);
  const cm = () =>
    r() < 0.25 ? pick([" # c", "\t# tab before", " #\ttab inside", " # a: b", " #"]) : "";
  const L: string[] = [];
  if (r() < 0.2) L.push("%YAML 1.2", "---");
  else if (chance(r, 0.2)) L.push("---");
  if (r() < 0.3) L.push(pick(["# top", "#\ttabbed top", "# top: with colon"]));
  L.push(`schemaVersion: 1${cm()}`, "platform: forge", `name: ${sc("Forge")}${cm()}`);
  if (r() < 0.3) L.push(`"key: with colon": ${sc("v: x")}${cm()}`);
  if (r() < 0.3) L.push(`'other:key': "a # not a comment"${cm()}`);
  const hasOwn = r() < 0.25;
  if (hasOwn) L.push("owners: &own", "  - team-a", "  - team-b");
  if (r() < 0.2) L.push("");
  L.push(`systems:${cm()}`);
  const n = 1 + Math.floor(r() * 3);
  const ind = r() < 0.3 ? "" : "  ";
  for (let i = 0; i < n; i++) {
    const id = i === 0 ? "ledger" : `sys-${i}`;
    if (r() < 0.25) {
      L.push(`${ind}- { id: ${id}, name: ${sc(id)}, boundary: product }${cm()}`);
      continue;
    }
    if (r() < 0.15) L.push(pick(["  # before item", "  #\ttab item"]));
    const p = ind;
    L.push(`${p}- id: ${id}${cm()}`, `${p}  name: ${sc(id)}${cm()}`);
    if (hasOwn && r() < 0.5) L.push(`${p}  owner: *own`);
    L.push(`${p}  boundary: product`);
    const d = r();
    if (d < 0.15) L.push(`${p}  description: >-`, `${p}    The books,`, `${p}    kept by a team`);
    else if (d < 0.25) L.push(`${p}  description: |`, `${p}    Line one`, "", `${p}    Line two`);
    else if (d < 0.3) L.push(`${p}  description: >`, `${p}    folded`, `${p}    keep`);
    else if (d < 0.35) L.push(`${p}  description: "a: b # c"`);
    else if (d < 0.4) L.push(`${p}  description:`, `${p}    plain multi`, `${p}    line scalar`);
    if (r() < 0.3) L.push(`${p}  aliases:${cm()}`, `${p}  - one`, `${p}  - 'two'${cm()}`);
    else if (chance(r, 0.3)) L.push(`${p}  aliases: [ a, b ]${cm()}`);
    const cc = r();
    if (cc < 0.3)
      L.push(
        `${p}  calls:${cm()}`,
        `${p}    - route: GET /forge/a/v1/x # declared by sam on 2026-01-02`,
        `${p}    - route: "POST /forge/b"${cm()}`,
      );
    else if (cc < 0.45) L.push(`${p}  calls: []`);
    else if (cc < 0.55) L.push(`${p}  calls: [ { route: GET /forge/c } ]`);
  }
  if (r() < 0.6)
    L.push(`environments: ${pick(["[dv, qa, prod]", "[ dv, qa ]", "\n  - dv\n  - qa"])}${cm()}`);
  if (r() < 0.2) L.push("# trailing", "");
  if (r() < 0.1) L.push("...");
  if (r() < 0.08) L.push("---", "other: doc");
  let t = L.join("\n") + (r() < 0.6 ? "\n" : "");
  if (r() < 0.05) t = t.replace(/\n/g, "\r\n");
  return t;
}

describe("a declaration on any profile (the re-review of G5)", () => {
  it("never changes what 2,000 random profiles say, their comments or where they sit", () => {
    const r = rng(0xc0ffee);
    let kept = 0;
    let fellBack = 0;
    let parseFail = 0;
    const normDiffs: string[] = [];
    const commentDiffs: string[] = [];
    const meaningDiffs: string[] = [];
    for (let k = 0; k < 2000; k++) {
      const before = profileOf(r);
      const doc = parseDocument(before);
      if (doc.errors.length) {
        parseFail++;
        continue;
      }
      const seq = doc.get("systems");
      if (!isSeq(seq)) continue;
      const sys = seq.items[0];
      if (!isMap(sys)) continue;
      let list = sys.get("calls");
      if (!isSeq(list)) {
        sys.set("calls", doc.createNode([]));
        list = sys.get("calls");
      }
      const item = doc.createNode({ route: "GET /forge/fees/v1/{id}" });
      item.comment = " declared by pat on 2026-11-14";
      (list as { add: (x: unknown) => void }).add(item);
      const after = doc.toString(OPTS);
      const out = keepUntouchedLines(before, after);
      if (out === after) fellBack++;
      else {
        kept++;
        if (parseDocument(out).toString(OPTS) !== after)
          normDiffs.push(`${before}\n---OUT---\n${out}`);
      }
      const a = JSON.stringify(strictJs(after));
      const o = JSON.stringify(strictJs(out));
      if (!isDeepStrictEqual(strictJs(after), strictJs(out)))
        meaningDiffs.push(`${a}\n${o}\n${JSON.stringify(before)}\n---OUT---\n${out}`);
      const ca = comments2(after);
      const co = comments2(out);
      if (JSON.stringify(ca) !== JSON.stringify(co))
        commentDiffs.push(
          `${JSON.stringify(ca)}\n${JSON.stringify(co)}\n---BEFORE---\n${before}\n---OUT---\n${out}\n---AFTER---\n${after}`,
        );
    }
    expect(normDiffs.slice(0, 2)).toEqual([]);
    expect(commentDiffs.slice(0, 2)).toEqual([]);
    expect(meaningDiffs.slice(0, 2)).toEqual([]);
    // Many still keep their lines (this generator is rough on purpose); the rest fall back.
    expect(kept).toBeGreaterThan(300);
    expect(kept + fellBack).toBeGreaterThan(1000);
    expect(parseFail).toBeLessThan(2000);
  }, 30_000);

  it("refuses a profile of several documents, writing nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-g5-multi-"));
    await mkdir(join(root, "org-pack/profiles/forge"), { recursive: true });
    const file = join(root, "org-pack/profiles/forge/profile.yaml");
    const before = [
      "schemaVersion: 1",
      "platform: forge",
      "name: Forge",
      "systems:",
      "  - id: ledger",
      "    name: Ledger",
      "    boundary: product",
      "---",
      "second: doc",
      "",
    ].join("\n");
    await writeFile(file, before);
    await expect(
      declareLink(
        root,
        { kind: "call", system: "ledger", route: "GET /forge/fees/v1/{id}" },
        { by: "pat", at: "2026-11-14T10:00:00.000Z" },
      ),
    ).rejects.toBeInstanceOf(DeclareError);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("declares on CRLF, anchors and quoted keys, keeping every other key and the declarations", async () => {
    const r = rng(7);
    let bad = 0;
    let ran = 0;
    for (let k = 0; k < 300; k++) {
      const root = await mkdtemp(join(tmpdir(), "rerev-g5d-"));
      await mkdir(join(root, "org-pack/profiles/forge"), { recursive: true });
      const file = join(root, "org-pack/profiles/forge/profile.yaml");
      let before = profileOf(r);
      if (/^---\nother/m.test(before) || /^\.\.\.$/m.test(before)) continue;
      if (parseDocument(before.replace(/\r\n/g, "\n")).errors.length) continue;
      if (!Profile.safeParse(parseDocument(before.replace(/\r\n/g, "\n")).toJS()).success) {
        continue;
      }
      if (r() < 0.5) before = before.replace(/\r?\n/g, "\r\n");
      await writeFile(file, before);
      const was = (await declaredOf(root, "ledger").catch(() => undefined))?.list;
      try {
        await declareLink(
          root,
          { kind: "call", system: "ledger", route: "GET /forge/fees/v1/{id}" },
          { by: "pat", at: "2026-11-14T10:00:00.000Z" },
        );
      } catch (e) {
        if (!String(e).includes("already has")) bad++;
        continue;
      }
      ran++;
      const now = await readFile(file, "utf8");
      const lf = now.replace(/\r\n/g, "\n");
      const bl = before.replace(/\r\n/g, "\n");
      if (before.includes("\r\n") && /[^\r]\n/.test(now)) {
        bad++;
      }
      const got = (await declaredOf(root, "ledger")).list;
      if (was && got.length !== was.length + 1) {
        bad++;
      }
      const m = strictJs(lf) as Record<string, unknown>;
      const mb = strictJs(bl) as Record<string, unknown>;
      for (const key of Object.keys(mb))
        if (key !== "systems" && JSON.stringify(mb[key]) !== JSON.stringify(m[key])) {
          bad++;
        }
    }
    expect(bad).toBe(0);
    expect(ran).toBeGreaterThan(20);
  }, 60_000);
});
