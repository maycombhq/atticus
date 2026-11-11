import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyCommand } from "../src/verify-commands.js";

/**
 * Beta.25 review, third round: nothing `atticus verify` says or writes about a rejected fact
 * holds a secret written on a line it cites: not the terminal, not `--json`, not
 * `<repo>.rejected.jsonl`, not `<repo>.verify.yaml`, not the kept facts. Every message passes one
 * sanitiser, and a fact citing a line that holds a secret (a key naming one, or a value shaped
 * like one) is quiet whatever key it claims. All invented (Forge; `.example` hosts).
 */
const STRONG = "q8Zt4LmN2vXy7RkP0sWd";
const SECRETS = [STRONG, "hunter22", "Hunter22wx", "Tr0ub4dor99", "changeme9", "Summer2024!"];
const F = "src/main/resources/application.yml";
const YML = [
  "spring:",
  "  datasource:",
  "    url: jdbc:postgresql://db.forge.internal:5432/ledger",
  "    username: ledger",
  "    password: hunter22",
  "forge:",
  "  base-url: https://ledger.forge.example",
  `  client-secret: ${STRONG}`,
  "  db-pw: Hunter22wx",
  "  signing:",
  "    pin: 482913",
  "  conn: postgres://admin:Tr0ub4dor99@db:5432/x",
  "  token: ${FORGE_TOKEN:changeme9}",
  "  admin-password: Summer2024!",
  "",
].join("\n");
const base = {
  repo: "forge-ledger",
  commit: "abcdef1",
  verified: "line",
  by: "assistant",
  conf: "declared",
};
const cfg = (id: string, o: Record<string, unknown>, cite: Record<string, unknown>) => ({
  kind: "config",
  id,
  settingKind: "config",
  ...base,
  ...o,
  cite: { file: F, ...cite },
});
const entry = (id: string, cite: Record<string, unknown>) => ({
  kind: "entry",
  id,
  ...base,
  entryType: "rest",
  method: "GET",
  path: "/conn",
  handler: "X.y",
  cite: { file: F, ...cite },
});
const URL = "https://ledger.forge.example";
const FACTS = [
  // a key naming no secret, cited on the client secret's line, its quote not that line's
  cfg(
    "config.a-wrong-line-strong",
    { key: "forge.base-url", value: URL },
    {
      line: 8,
      value: "base-url",
      quote: `base-url: ${URL}`,
    },
  ),
  // the same on the password's line
  cfg(
    "config.b-wrong-line-weak",
    { key: "spring.datasource.url", value: "jdbc:postgresql://db.forge.internal:5432/ledger" },
    { line: 5, value: "url", quote: "url: jdbc:postgresql://db.forge.internal:5432/ledger" },
  ),
  // a key naming no secret that holds a password, its quote wrong
  cfg(
    "config.c-dbpw-quote",
    { key: "forge.db-pw", value: "Hunter22wx" },
    {
      line: 9,
      value: "db-pw",
      quote: "db-pw: something",
    },
  ),
  // a secret's key with a source, its quote wrong
  cfg(
    "config.d-secret-quote",
    { key: "spring.datasource.password", source: "env:DB_PASSWORD" },
    {
      line: 5,
      value: "password",
      quote: "password: ${DB_PASSWORD}",
    },
  ),
  // a secret's key with a part on another line
  cfg(
    "config.e-part-wrong",
    { key: "spring.datasource.password", source: "env:DB_PASSWORD" },
    {
      line: 5,
      value: "password",
      with: [{ file: F, line: 1, value: "hunter22" }],
    },
  ),
  // a URL with a user and password, on its own line
  cfg(
    "config.f-conn",
    { key: "forge.conn", value: "postgres://admin:Tr0ub4dor99@db:5432/x" },
    {
      line: 12,
      value: "conn",
    },
  ),
  // a literal default under a secret's key, claimed under another key
  cfg(
    "config.g-default-wrongkey",
    { key: "forge.tokenx", value: "${FORGE_TOKEN:changeme9}" },
    {
      line: 13,
      value: "token",
    },
  ),
  // a secret's key whose quote is another line's secret
  cfg(
    "config.h-adminpw-wrongline",
    { key: "forge.admin-password", source: "env:ADMIN_PW" },
    {
      line: 9,
      value: "admin-password",
      quote: "admin-password: Summer2024!",
    },
  ),
  // a key naming no secret whose quote is a secret's line
  cfg(
    "config.i-quote-is-secret",
    { key: "forge.base-url", value: URL },
    {
      line: 7,
      value: "base-url",
      quote: "admin-password: Summer2024!",
    },
  ),
  // a key naming no secret, cited on the admin password's line
  cfg(
    "config.j-wrongline-marks",
    { key: "forge.base-url", value: URL },
    {
      line: 14,
      value: "base-url",
      quote: `base-url: ${URL}`,
    },
  ),
  // an entry on a line with a URL's password, its quote another line's
  entry("entry.k", { line: 12, value: "conn", quote: '@GetMapping("/conn")' }),
  // a value claimed that the line doesn't set
  cfg(
    "config.l-value-claim",
    { key: "forge.db-pw", value: "Hunter22wx-other" },
    {
      line: 9,
      value: "db-pw",
    },
  ),
  // lines beside a secret's
  cfg(
    "config.n-adjacent-strong",
    { key: "forge.base-url", value: URL },
    {
      line: 8,
      value: "base-url",
      quote: "nope",
    },
  ),
  cfg(
    "config.o-adjacent-weak",
    { key: "spring.datasource.username", value: "ledger" },
    {
      line: 5,
      value: "username",
      quote: "nope",
    },
  ),
  entry("entry.p", { line: 13, value: "admin-password", quote: "nope" }),
  // a key naming no secret whose value is the admin password, on its line
  cfg(
    "config.q-wrongkey-weak",
    { key: "forge.base-url", value: "Summer2024!" },
    {
      line: 14,
      value: "admin-password",
    },
  ),
  // and one that holds
  cfg("config.m-ok", { key: "forge.base-url", value: URL }, { line: 7, value: "base-url" }),
];

describe("atticus verify and a secret on a line a rejected fact cites", () => {
  const roots: string[] = [];
  const out: Record<string, string> = {};
  const mk = async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-leak-"));
    roots.push(root);
    await mkdir(join(root, ".atticus", "org-pack"), { recursive: true });
    await mkdir(join(root, ".atticus", "facts"), { recursive: true });
    await mkdir(join(root, "src/main/resources"), { recursive: true });
    await writeFile(join(root, F), YML);
    await writeFile(
      join(root, ".atticus", "facts", "forge-ledger.jsonl"),
      FACTS.map((f) => JSON.stringify(f)).join("\n") + "\n",
    );
    return root;
  };
  const run = async (root: string, json: boolean) => {
    const said: string[] = [];
    const io = { out: (l: string) => said.push(l), err: (l: string) => said.push(l) };
    await verifyCommand(
      root,
      "forge-ledger",
      { commit: "abcdef1", ...(json ? { json: true } : {}) },
      io,
    );
    return said.join("\n");
  };
  beforeAll(async () => {
    const r1 = await mk();
    const r2 = await mk();
    out.terminal = await run(r1, false);
    out.json = await run(r2, true);
    const d = join(r1, ".atticus", "facts");
    const text = (n: string) => readFile(join(d, n), "utf8").catch(() => "");
    out.rejected = await text("forge-ledger.rejected.jsonl");
    out.verifyYaml = await text("forge-ledger.verify.yaml");
    out.kept = await text("forge-ledger.jsonl");
  });
  afterAll(async () => {
    for (const r of roots) await rm(r, { recursive: true, force: true });
  });

  it.each(["terminal", "json", "rejected", "verifyYaml", "kept"])(
    "says no secret in %s",
    (where) => {
      expect(out[where]).toBeTruthy();
      for (const s of SECRETS) expect(out[where], `${where} holds ${s}`).not.toContain(s);
    },
  );

  // config.a's claim and quote are the line beside the one it cites, which holds (the check reads
  // a line either side), so it is kept as m-ok is, the secret's line none of its text
  const KEPT = new Set(["config.a-wrong-line-strong", "config.m-ok"]);
  it("rejects every fact but those that hold, and keeps those", () => {
    // a fact's line the schema refused (a URL's password in its value) is kept as its raw line
    const rejected = out
      .rejected!.trim()
      .split("\n")
      .map((l) => /\\?"id\\?":\\?"([^"\\]+)/.exec(l)?.[1]);
    expect(new Set(rejected)).toEqual(
      new Set(FACTS.filter((f) => !KEPT.has(f.id)).map((f) => f.id)),
    );
    for (const id of KEPT) expect(out.kept).toContain(`"id":"${id}"`);
  });

  it("still says what is wrong, with the secret's text taken out", () => {
    expect(out.rejected).toContain("<redacted>");
    expect(out.rejected).toContain("quote-mismatch");
  });
});
