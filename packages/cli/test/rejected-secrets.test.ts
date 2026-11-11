import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFactsLines } from "@maycombhq/core";
import { verifyFacts, type FileSource, type VerifyReport } from "@maycombhq/verify";
import { writeVerifyFiles } from "../src/facts-files.js";
import { verifyCommand } from "../src/verify-commands.js";

/**
 * Beta.25 review: a fact refused for the secret it carries never puts the secret in
 * `<repo>.rejected.jsonl`, whether the schema refused its line (beta.24's value check) or the
 * verifier refused it (`secret-value`: a part, a source, a Basic token). All invented.
 */
const SECRET = "q8Zt4LmN2vXy7RkP0sWd";
const BASIC = "Basic Zm9yZ2U6czNjcmV0MTIzNDU2";
const X = "/AssignMessage/Set/Headers/Header[@name='x-api-key']";
const config = (over: Record<string, unknown>, cite: Record<string, unknown> = {}) => ({
  kind: "config",
  id: "config.key",
  repo: "forge-wallets-proxy",
  commit: "abcdef1",
  key: X,
  target: "AM-Key.xml",
  env: "prod",
  cite: { file: "config.json", line: 10, value: "Header", ...cite },
  verified: "line",
  by: "assistant",
  conf: "declared",
  ...over,
});
const FILES: Record<string, string> = {
  "config.json": [
    "{",
    '  "configurations": [',
    "    {",
    '      "name": "prod",',
    '      "policies": [',
    "        {",
    '          "name": "AM-Key.xml",',
    '          "tokens": [',
    "            {",
    `              "xpath": "${X}",`,
    `              "value": "${SECRET}"`,
    "            }",
    "          ]",
    "        }",
    "      ]",
    "    }",
    "  ]",
    "}",
  ].join("\n"),
  "apiproxy/policies/AM-Key.xml": "<AssignMessage/>",
};
const memory = (files: Record<string, string>): FileSource => ({
  list: () => Object.keys(files),
  read: (p) => files[p],
});

describe("<repo>.rejected.jsonl and a secret", () => {
  it("keeps neither a schema-refused line's secret nor a verifier-refused fact's", async () => {
    const text = [
      // Beta.24's schema refuses a secret-named value and one shaped like a secret.
      config({ id: "config.value", value: SECRET }),
      config({
        id: "config.url",
        key: "ledger.url",
        value: "https://svc:pa55w0rdQ@ledger.forge.example",
      }),
      // The verifier refuses a secret in a part, the source or a Basic token.
      config({ id: "config.part" }, { with: [{ file: "config.json", line: 11, value: SECRET }] }),
      config({ id: "config.source", source: SECRET }),
      config({ id: "config.basic", key: "x.authorization", value: BASIC }),
    ]
      .map((f) => JSON.stringify(f))
      .join("\n");
    const parsed = parseFactsLines(text);
    expect(parsed.bad).toHaveLength(2);
    const report: VerifyReport = await verifyFacts({
      facts: parsed.facts,
      source: memory(FILES),
      commit: "abcdef1",
    });
    expect(report.rejected.map((r) => r.fact.id).sort()).toEqual([
      "config.basic",
      "config.part",
      "config.source",
    ]);
    const root = await mkdtemp(join(tmpdir(), "atticus-secret-"));
    try {
      await writeVerifyFiles(
        root,
        "forge-wallets-proxy",
        report,
        "abcdef1",
        [],
        parsed.bad.map((b) => ({ line: b.line, raw: b.raw, message: "schema" })),
      );
      const out = await readFile(join(root, "facts", "forge-wallets-proxy.rejected.jsonl"), "utf8");
      expect(out.trim().split("\n")).toHaveLength(5);
      for (const s of [SECRET, "pa55w0rdQ", "Zm9yZ2U6czNjcmV0MTIzNDU2"])
        expect(out).not.toContain(s);
      expect(out).toContain("<redacted>");
      // The refused line is kept, its id and all, so its reader can fix it.
      expect(out).toContain('\\"id\\":\\"config.value\\"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * Beta.25 review, second round: a fact refused for its secret and for something else (a part
 * not on its line, a quote that doesn't match) never has the secret said, in any file or output
 * of `atticus verify`: `<repo>.rejected.jsonl`, the `rejections` of `<repo>.verify.yaml`, the
 * terminal, and the report `--json` prints.
 */
describe("atticus verify and a secret", () => {
  const WEAK = "hunter22";
  const lines = [
    // a strong secret as a part on the wrong line, and as the source
    config(
      { id: "config.part-wrong-line", source: SECRET },
      { with: [{ file: "config.json", line: 2, value: SECRET }] },
    ),
    // a weak password as the source, its quote holding it, on a line that doesn't read so
    config({ id: "config.weak-source", source: WEAK }, { quote: `"value": "${WEAK}"` }),
    // a weak password as a part on the wrong line, under a secret's key
    config(
      { id: "config.weak-part", source: "env:NORTHWIND_KEY" },
      { with: [{ file: "config.json", line: 2, value: WEAK }] },
    ),
    // the secret's own line cited with a quote that doesn't match it
    config(
      { id: "config.quote-mismatch", source: "env:NORTHWIND_KEY" },
      { line: 11, value: "value", quote: '"value": "nope"' },
    ),
  ].map((f) => JSON.stringify(f));
  const adopted = async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-secret-cli-"));
    await mkdir(join(root, ".atticus", "org-pack"), { recursive: true });
    await mkdir(join(root, ".atticus", "facts"), { recursive: true });
    await mkdir(join(root, "apiproxy", "policies"), { recursive: true });
    for (const [p, t] of Object.entries(FILES)) await writeFile(join(root, p), t);
    await writeFile(
      join(root, ".atticus", "facts", "forge-wallets-proxy.jsonl"),
      lines.join("\n") + "\n",
    );
    return root;
  };
  const run = async (root: string, json: boolean) => {
    const said: string[] = [];
    const io = { out: (l: string) => said.push(l), err: (l: string) => said.push(l) };
    await verifyCommand(
      root,
      "forge-wallets-proxy",
      { commit: "abcdef1", ...(json ? { json: true } : {}) },
      io,
    );
    return { lines: said, said: said.join("\n") };
  };

  it("says it nowhere: rejected.jsonl, verify.yaml, the terminal and --json", async () => {
    // two checkouts: a run keeps only the facts it kept in the facts file
    const root = await adopted();
    const other = await adopted();
    try {
      const text = await run(root, false);
      expect(text.said).toMatch(/0 facts kept, 4 rejected/);
      const facts = join(root, ".atticus", "facts");
      const rejected = await readFile(join(facts, "forge-wallets-proxy.rejected.jsonl"), "utf8");
      const yaml = await readFile(join(facts, "forge-wallets-proxy.verify.yaml"), "utf8");
      const json = await run(other, true);
      const report = JSON.parse(json.lines.find((l) => l.startsWith("{"))!) as {
        rejections: { id: string }[];
      };
      expect(report.rejections.map((r) => r.id).sort()).toEqual([
        "config.part-wrong-line",
        "config.quote-mismatch",
        "config.weak-part",
        "config.weak-source",
      ]);
      for (const [where, t] of Object.entries({
        rejected,
        yaml,
        terminal: text.said,
        json: json.said,
      })) {
        expect(t, where).not.toContain(SECRET);
        expect(t, where).not.toContain(WEAK);
      }
      expect(rejected).toContain("carries a secret in its source");
      expect(rejected).toContain("<redacted>");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true });
    }
  });
});
