import { describe, expect, it } from "vitest";
import { RECORD_KINDS, deserializeRecord, parseRecord, serializeRecord } from "../src/index.js";
import { EXAMPLES } from "./examples.js";

function parsed(kind: (typeof RECORD_KINDS)[number]) {
  const r = parseRecord(EXAMPLES[kind]);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.record;
}

describe("canonical serialization", () => {
  it.each(RECORD_KINDS)("round-trips %s byte-for-byte", (kind) => {
    const record = parsed(kind);
    const text = serializeRecord(record);
    const back = deserializeRecord(text);
    if (!back.ok) throw new Error(JSON.stringify(back.issues));
    expect(back.record).toEqual(record);
    expect(serializeRecord(back.record)).toBe(text);
  });

  it("prints leading keys first, then the rest alphabetically", () => {
    const text = serializeRecord(parsed("System"));
    const keys = text
      .split("\n")
      .filter((l) => /^[a-zA-Z]/.test(l))
      .map((l) => l.split(":")[0]);
    expect(keys.slice(0, 5)).toEqual(["schemaVersion", "kind", "id", "status", "confidence"]);
    const rest = keys.slice(5);
    expect(rest).toEqual([...rest].sort());
  });

  it("is independent of input key order", () => {
    const a = parsed("Table");
    const reversed = Object.fromEntries(Object.entries(EXAMPLES.Table).reverse());
    const b = parseRecord(reversed);
    if (!b.ok) throw new Error("parse failed");
    expect(serializeRecord(b.record)).toBe(serializeRecord(a));
  });

  it("uses LF endings and exactly one trailing newline", () => {
    const text = serializeRecord(parsed("Interface"));
    expect(text).not.toContain("\r");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  it("never folds long strings", () => {
    const long = "x ".repeat(200).trim();
    const r = parseRecord({ ...EXAMPLES.Decision, reason: long });
    if (!r.ok) throw new Error("parse failed");
    const text = serializeRecord(r.record);
    expect(text.split("\n").some((l) => l.includes(long))).toBe(true);
  });

  it("reports invalid YAML without throwing", () => {
    const r = deserializeRecord("kind: [unclosed");
    expect(r.ok).toBe(false);
  });

  it("reports schema problems with paths", () => {
    const r = deserializeRecord("schemaVersion: 1\nkind: System\nid: x\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.path)).toContain("evidence");
  });
});
