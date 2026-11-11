import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFacts, parseFactsLines, type Fact } from "../src/index.js";

/**
 * Review of beta.25 (ADR 0192 addendum §8): a value or a field a newer Atticus wrote is left out
 * and kept as written, but a slip of the assistant's (`scope: "complie"`, `scpoe`) is a fact the
 * schema refuses, so it goes back to the assistant to fix instead of being kept forever unread.
 * A value within two edits of one of its list's is a slip; a field one edit from one the kind has,
 * starting with its letter and no plural (or `-d`) of it, is a slip. Invented Forge names only.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "library-deps");
const text = readFileSync(join(FIX, "facts", "forge-ledger.jsonl"), "utf8").trim();
const known = (): Fact[] => {
  const r = parseFacts(text);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const first = () => known().find((f) => f.kind === "dependency")!;
const line = (extra: Record<string, unknown>, drop?: string) => {
  const o: Record<string, unknown> = { ...first(), id: "dependency.x", ...extra };
  if (drop) delete o[drop];
  return JSON.stringify(o);
};
/** How one extra line reads: newer (left out, kept), refused (a bad line), or a fact. */
const read = (l: string) => {
  const all = parseFacts(`${text}\n${l}\n`);
  const lines = parseFactsLines(`${text}\n${l}\n`);
  const how = lines.newer.length ? "newer" : lines.bad.length ? "refused" : "fact";
  // both reads agree
  expect(all.ok).toBe(how !== "refused");
  return { how, lines, all };
};

describe("a slip of a list's value is refused, a newer value left out (review of beta.25)", () => {
  it.each([
    ["scope", "complie"],
    ["scope", "runtine"],
    ["scope", "provied"],
    ["scope", "tests"],
    ["conf", "declard"],
    ["conf", "infered"],
    ["verified", "lnie"],
    ["verified", "nnoe"],
    ["by", "asistant"],
    ["by", "persn"],
  ])("refuses %s %j as a slip, saying what it may have meant", (field, value) => {
    const r = read(line({ [field]: value }));
    expect(r.how).toBe("refused");
    const said = r.lines.bad[0]!.issues.map((i) => i.message).join("; ");
    expect(said).toContain(`${field}:`);
    expect(said).toContain("did you mean");
  });

  it("refuses scope system, saying to record it as provided", () => {
    const r = read(line({ scope: "system" }));
    expect(r.how).toBe("refused");
    expect(r.lines.bad[0]!.issues.map((i) => i.message)).toEqual([
      "scope: record a system-scoped dependency as provided",
    ]);
    if (!r.all.ok)
      expect(r.all.issues.map((i) => i.message)).toEqual([
        "scope: record a system-scoped dependency as provided",
      ]);
    // a JSON array says it too
    const arr = parseFacts(JSON.stringify([JSON.parse(line({ scope: "system" }))]));
    expect(arr.ok).toBe(false);
    if (!arr.ok)
      expect(arr.issues[0]!.message).toBe("0.scope: record a system-scoped dependency as provided");
  });

  it.each([
    ["scope", "shaded"],
    ["scope", "bundled"],
    ["scope", "annotation-processor"],
    ["conf", "estimated"],
    ["verified", "replayed"],
    ["by", "importer"],
  ])("leaves out %s %j as a newer Atticus's, kept as written", (field, value) => {
    const l = line({ [field]: value });
    const r = read(l);
    expect(r.how).toBe("newer");
    expect(r.lines.newer[0]!.raw).toBe(l);
    expect(r.lines.newer[0]!.message).toContain(`${field} "${value}"`);
  });
});

describe("a slip of a field's name is refused, a newer field left out (review of beta.25)", () => {
  it.each([
    "scpoe",
    "groupp",
    "verison",
    "vesion",
    "nmae",
    "comit",
    "componnet",
    "verifed",
    "repp",
    "cnof",
  ])("refuses %s as a slip of a dependency fact's field", (key) => {
    const r = read(line({ [key]: "x" }));
    expect(r.how).toBe("refused");
    expect(r.lines.bad[0]!.issues.map((i) => i.code)).toContain("unrecognized_keys");
  });

  it.each([
    "lines",
    "path",
    "note",
    "size",
    "date",
    "code",
    "lang",
    "hint",
    "since",
    "title",
    "named",
    "scopes",
    "versions",
    "components",
    "repos",
  ])("leaves out %s as a newer Atticus's field of a dependency fact, kept as written", (key) => {
    const l = line({ [key]: "x" });
    const r = read(l);
    expect(r.how).toBe("newer");
    expect(r.lines.newer[0]!.raw).toBe(l);
    expect(r.lines.newer[0]!.message).toContain(`field ${key} is new to the dependency fact`);
  });

  it("reads a citation's fields the same way", () => {
    const cite = first().cite;
    expect(read(line({ cite: { ...cite, qoute: "x" } })).how).toBe("refused");
    expect(read(line({ cite: { ...cite, lines: [2, 3] } })).how).toBe("newer");
  });
});
