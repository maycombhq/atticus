import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFactsLines } from "@maycombhq/core";
import { verifyFacts, type FileSource, type VerifyReport } from "@maycombhq/verify";
import { writeVerifyFiles } from "../src/facts-files.js";

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
