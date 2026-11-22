import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MockRuntime, type AiRuntime } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { main } from "../src/main.js";
import { REVIEW_WORDS, reviewCommand, withRows } from "../src/review-commands.js";

/**
 * ADR 0203 C.4: `atticus review <requirements.md | change>` on the Forge metarepo. The door
 * check's reasons as findings, the map's standing of each cited id, the naysayers whose heading
 * the file has; always exit 0; --write adds rows once and keeps the file's line endings.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const NOW = new Date("2026-11-19T09:00:00Z");
const T = 60_000;
const NAYSAYER = "application-architect-naysayer";

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

async function forgeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-cli-review-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  for (const r of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(String(r.id));
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await mkdir(join(root, "openspec/changes"), { recursive: true });
  await mkdir(join(root, "org-pack/agents"), { recursive: true });
  await writeFile(
    join(root, "org-pack/agents", `${NAYSAYER}.md`),
    readFileSync(join(HERE, "../../assistant-files/starter/agents", `${NAYSAYER}.md`), "utf8"),
  );
  return root;
}

const FILE = [
  "# Shipped-orders event",
  "",
  "Orders tell the ledger when they ship.",
  "",
  "## Planned",
  "",
  "- `topic.orders-shipped`: the new topic",
  "",
  "## Application architect",
  "",
  "The ledger reads the new topic and books each shipment.",
  "",
  "| Question | Evidence | Asked by | Answered by | Answer | State |",
  "| --- | --- | --- | --- | --- | --- |",
  "| Who reads the topic? | `topic.orders-shipped` | application-architect-naysayer | pat | Ledger only | answered |",
  "| Is the ledger ready? | `forge-nowhere` | application-architect-naysayer | - | - | open |",
  "",
].join("\n");

/** The naysayer asks once, quoting line 11; every other agent finds nothing. */
const model = () =>
  new MockRuntime(
    (req) =>
      req.agent.id !== NAYSAYER
        ? "findings: []"
        : [
            "findings:",
            `  - rule: persona.${NAYSAYER}`,
            "    kind: issue",
            "    artifact: requirements.md",
            "    locator: { line: 11 }",
            "    summary: Nothing says what the ledger does with a shipment it has booked.",
            "    why: A second booking doubles the entry.",
            "    fix: Say it.",
            "    evidence:",
            '      - { path: requirements.md, line: 11, quote: "books each shipment" }',
            "  - rule: persona." + NAYSAYER,
            "    kind: issue",
            "    artifact: requirements.md",
            "    locator: { line: 3 }",
            "    summary: A question whose quote isn't there.",
            "    why: Dropped.",
            "    fix: Nothing.",
            "    evidence:",
            '      - { path: requirements.md, line: 3, quote: "words that are on no line of the file" }',
            "",
          ].join("\n"),
    { now: () => NOW },
  );

describe("atticus review", () => {
  it(
    "prints the door check, the map's standing and the naysayer's question, and exits 0",
    async () => {
      const root = await forgeRoot();
      const file = join(root, "..", `${root.split(/[\\/]/).at(-1)}-requirements.md`);
      await writeFile(file, FILE);
      const c = capture();
      expect(await reviewCommand(root, file, {}, c.io, { runtime: model(), now: NOW })).toBe(0);
      expect(c.err).toEqual([]);
      expect(c.out).toEqual([
        `${file}:11: ${NAYSAYER}: Nothing says what the ledger does with a shipment it has booked. [requirements.md:11]`,
        `${file}:15: atticus: topic.orders-shipped is listed under Planned, so the map can't check it yet [topic.orders-shipped]`,
        `${file}:16: atticus: Application architect has an open question: "Is the ledger ready?". Answer it (State answered) or accept it (State accepted, with who and why), then run this again. [requirements.open-question]`,
        `${file}:16: atticus: the evidence names forge-nowhere, which is not in the map and not listed under "## Planned". Name an id the map has (atticus query forge-nowhere), or list it under Planned. [requirements.unknown-id]`,
        "1 question of the naysayers left out: its quote isn't on the line it cites.",
      ]);
      // --no-ai: no naysayer; a file that can't be read: exit 1.
      const plain = await main(["review", file, "--no-ai", "--root", root], capture().io, {
        quiet: true,
      });
      expect(plain).toBe(0);
      const gone = capture();
      expect(await main(["review", `${file}.gone`, "--root", root], gone.io, { quiet: true })).toBe(
        1,
      );
      expect(gone.err[0]).toMatch(/^Can't read /);
    },
    T,
  );

  it(
    "--write adds each finding not already there as a row of its role's table, once, keeping CRLF",
    async () => {
      const root = await forgeRoot();
      const file = join(root, "requirements.md");
      await writeFile(file, FILE.replace(/\n/g, "\r\n"));
      const once = capture();
      await reviewCommand(root, file, { write: true }, once.io, { runtime: model(), now: NOW });
      expect(once.out.at(-1)).toBe(`Added 3 rows to ${file}.`);
      const text = await readFile(file, "utf8");
      expect(/[^\r]\n/.test(text)).toBe(false);
      const lines = text.split("\r\n");
      expect(lines.slice(14, 19)).toEqual([
        "| Who reads the topic? | `topic.orders-shipped` | application-architect-naysayer | pat | Ledger only | answered |",
        "| Is the ledger ready? | `forge-nowhere` | application-architect-naysayer | - | - | open |",
        "| Nothing says what the ledger does with a shipment it has booked. | - | application-architect-naysayer | - | - | open |",
        "| topic.orders-shipped is listed under Planned, so the map can't check it yet | topic.orders-shipped | atticus | - | - | open |",
        `| the evidence names forge-nowhere, which is not in the map and not listed under "## Planned". Name an id the map has (atticus query forge-nowhere), or list it under Planned. | - | atticus | - | - | open |`,
      ]);
      const twice = capture();
      await reviewCommand(root, file, { write: true }, twice.io, { runtime: model(), now: NOW });
      expect(twice.out.at(-1)).toBe(`${file} has every row already.`);
      expect(await readFile(file, "utf8")).toBe(text);
    },
    T,
  );

  it(
    "--write keeps the file's encoding (UTF-16, a UTF-8 BOM) and each line's own ending",
    async () => {
      const root = await forgeRoot();
      const rows = (text: string) =>
        text.split(/\r\n|\n/).filter((l) => l.endsWith("| - | - | open |"));
      // UTF-16LE with its byte-order mark, as Windows PowerShell 5 writes it.
      const u16 = join(root, "u16.md");
      await writeFile(
        u16,
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(FILE, "utf16le")]),
      );
      await reviewCommand(root, u16, { write: true }, capture().io, { runtime: model(), now: NOW });
      const b16 = await readFile(u16);
      expect([...b16.subarray(0, 2)]).toEqual([0xff, 0xfe]);
      const t16 = b16.subarray(2).toString("utf16le");
      expect(rows(t16).length).toBeGreaterThan(0);
      expect(t16.startsWith("# Shipped-orders event\n")).toBe(true);
      // UTF-8 with a byte-order mark.
      const bom = join(root, "bom.md");
      await writeFile(
        bom,
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(FILE, "utf8")]),
      );
      await reviewCommand(root, bom, { write: true }, capture().io, { runtime: model(), now: NOW });
      const b8 = await readFile(bom);
      expect([...b8.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(b8.subarray(3, 5).toString("utf8")).toBe("# ");
      // Mixed endings: every line Atticus didn't add keeps its own; a new row takes the one before it.
      const mixed = join(root, "mixed.md");
      const lines = FILE.split("\n");
      const text = lines
        .map((l, i) => (i === lines.length - 1 ? l : l + (i % 2 ? "\r\n" : "\n")))
        .join("");
      await writeFile(mixed, text);
      await reviewCommand(root, mixed, { write: true }, capture().io, {
        runtime: model(),
        now: NOW,
      });
      const after = await readFile(mixed, "utf8");
      const withoutNew = after
        .split(/(?<=\n)/)
        .filter((l) => !/\| - \| - \| open \|\r?\n$/.test(l) || text.includes(l))
        .join("");
      expect(withoutNew).toBe(text);
    },
    T,
  );

  it(
    "--write is idempotent for a question that holds a bar",
    async () => {
      const root = await forgeRoot();
      const file = join(root, "requirements.md");
      await writeFile(file, FILE);
      const barred = () =>
        new MockRuntime(
          (req) =>
            req.agent.id !== NAYSAYER
              ? "findings: []"
              : [
                  "findings:",
                  `  - rule: persona.${NAYSAYER}`,
                  "    kind: issue",
                  "    artifact: requirements.md",
                  "    locator: { line: 11 }",
                  '    summary: "Is it ledger | billing that books it?"',
                  "    why: Two readers.",
                  "    fix: Say which.",
                  "    evidence:",
                  '      - { path: requirements.md, line: 11, quote: "books each shipment" }',
                  "",
                ].join("\n"),
          { now: () => NOW },
        );
      await reviewCommand(root, file, { write: true }, capture().io, {
        runtime: barred(),
        now: NOW,
      });
      const once = await readFile(file, "utf8");
      expect(once).toContain("| Is it ledger \\| billing that books it? | - |");
      const twice = capture();
      await reviewCommand(root, file, { write: true }, twice.io, { runtime: barred(), now: NOW });
      expect(twice.out.at(-1)).toBe(`${file} has every row already.`);
      expect(await readFile(file, "utf8")).toBe(once);
    },
    T,
  );

  it("makes the heading and the table when the role has none", () => {
    const w = withRows("# T\n\nWords.\n", [
      { line: 1, who: "qa-naysayer", question: "What if it fails?", evidence: "-", role: "QA" },
    ]);
    expect(w).toEqual({
      added: 1,
      text: [
        "# T",
        "",
        "Words.",
        "",
        "## QA",
        "",
        "| Question | Evidence | Asked by | Answered by | Answer | State |",
        "| --- | --- | --- | --- | --- | --- |",
        "| What if it fails? | - | qa-naysayer | - | - | open |",
        "",
      ].join("\n"),
    });
  });

  it("adds under a role's header-only table, never a second header (the second review of beta.30)", () => {
    const header = [
      "| Question | Evidence | Asked by | Answered by | Answer | State |",
      "| --- | --- | --- | --- | --- | --- |",
    ];
    const text = ["# T", "", "## QA", "", "Words.", "", ...header, "", "## Planned", ""].join("\n");
    const w = withRows(text, [
      { line: 1, who: "qa-naysayer", question: "What if it fails?", evidence: "-", role: "QA" },
    ]);
    expect(w).toEqual({
      added: 1,
      text: [
        "# T",
        "",
        "## QA",
        "",
        "Words.",
        "",
        ...header,
        "| What if it fails? | - | qa-naysayer | - | - | open |",
        "",
        "## Planned",
        "",
      ].join("\n"),
    });
  });

  it("reads a lone carriage return as the door check does: inside its line, kept", () => {
    const text = [
      "# T",
      "",
      "Words\rmore words.",
      "",
      "## QA",
      "",
      "| Question | Evidence | Asked by | Answered by | Answer | State |",
      "| --- | --- | --- | --- | --- | --- |",
      "| Who books it? | - | qa-naysayer | pat | Ledger | answered |",
      "",
    ].join("\n");
    const w = withRows(text, [
      { line: 1, who: "qa-naysayer", question: "What if it fails?", evidence: "-", role: "QA" },
    ]);
    expect(w.text).toBe(
      text.replace(
        "| answered |\n",
        "| answered |\n| What if it fails? | - | qa-naysayer | - | - | open |\n",
      ),
    );
  });

  it(
    "exits 0 when a naysayer's run throws, and says why in the review's words",
    async () => {
      const root = await forgeRoot();
      const file = join(root, "requirements.md");
      await writeFile(file, FILE);
      const broken = {
        prepare: () => Promise.reject(new Error("the model provider went away")),
      } as unknown as AiRuntime;
      const c = capture();
      expect(await reviewCommand(root, file, {}, c.io, { runtime: broken, now: NOW })).toBe(0);
      expect(c.out).toContain(REVIEW_WORDS.failed("the model provider went away"));
      expect(c.out.some((l) => l.includes("requirements.open-question"))).toBe(true);
      const j = capture();
      expect(
        await reviewCommand(root, file, { json: true }, j.io, { runtime: broken, now: NOW }),
      ).toBe(0);
      expect((JSON.parse(j.out.join("\n")) as { notes: string[] }).notes).toEqual([
        REVIEW_WORDS.failed("the model provider went away"),
      ]);
    },
    T,
  );
});
