import { describe, expect, it } from "vitest";
import {
  claimOnLines,
  fieldKey,
  isSecretPath,
  lineNamesField,
  lineNamesRoute,
  lineNamesWord,
  normalizeQuote,
  quoteMatches,
  quoteNotRequired,
  redactSecrets,
} from "../src/index.js";

describe("claim on the line (ADR 0089, moved to core for the verifier of ADR 0124)", () => {
  it("names a route in any parameter style, or by its tail", () => {
    expect(lineNamesRoute('@GetMapping("/accounts/{accountId}")', "/accounts/{accountId}")).toBe(
      true,
    );
    expect(lineNamesRoute("router.get('/accounts/:id', h)", "/accounts/{accountId}")).toBe(true);
    expect(lineNamesRoute('@PostMapping("/entries")', "/accounts/{id}/entries")).toBe(true);
    expect(lineNamesRoute("fetch(base + '/v1/rates/' + pair)", "/v1/rates/{pair}")).toBe(true);
    expect(lineNamesRoute('@GetMapping("/accountsx")', "/accounts")).toBe(false);
    // a root route, or one of parameters only, is named by its literal (feedback from the A4 run)
    expect(lineNamesRoute('  @GetMapping("/")', "/")).toBe(true);
    expect(lineNamesRoute('app.MapGet("/", () => ...)', "/")).toBe(true);
    expect(lineNamesRoute('  @GetMapping("/{id}")', "/{id}")).toBe(true);
    expect(lineNamesRoute("router.get('/:id', h)", "/{id}")).toBe(true);
    expect(lineNamesRoute("  return x / y;", "/")).toBe(false);
  });
  it("names a word not inside a longer word, and a field letter case and separators aside", () => {
    expect(lineNamesWord('@Table(name = "entry")', "entry")).toBe(true);
    expect(lineNamesWord("entries.push(x)", "entry")).toBe(false);
    expect(lineNamesField("private String firstName;", "first_name")).toBe(true);
    expect(fieldKey("owner.first_name")).toBe("firstname");
  });
  it("looks within one line either side of the cited one", () => {
    const lines = ["", "@PostMapping(", '  "/accounts/{id}/entries")', "public void post() {"];
    expect(claimOnLines(lines, 2, { kind: "route", value: "/accounts/{id}/entries" })).toBe(true);
    expect(claimOnLines(lines, 4, { kind: "route", value: "/accounts/{id}/entries" })).toBe(true);
    expect(claimOnLines(lines, 1, { kind: "route", value: "/accounts/{id}/entries" })).toBe(false);
    expect(claimOnLines(lines, 4, { kind: "word", value: "nowhere" })).toBe(false);
  });
});

describe("quotes (ADR 0103 forgiveness, ADR 0124 anchors)", () => {
  it("normalises whitespace, line endings, quote marks and end punctuation", () => {
    expect(normalizeQuote('  a   =  "b";\r\n')).toBe('a = "b"');
    expect(normalizeQuote("x = ‘y’.")).toBe("x = 'y'");
  });
  it("matches a quote that is the line, a prefix of it, or inside it, after normalisation", () => {
    const line = '    return rest.getForObject(base + "/v1/rates/" + pair, Rate.class);';
    expect(
      quoteMatches(line, 'return rest.getForObject(base + "/v1/rates/" + pair, Rate.class)'),
    ).toBe(true);
    expect(quoteMatches(line, "return rest.getForObject(")).toBe(true);
    expect(quoteMatches(line, "'/v1/rates/' + pair")).toBe(true);
    expect(quoteMatches(line, "return rest.postForObject(")).toBe(false);
    expect(quoteMatches(line, "")).toBe(true);
    // a quote stored redacted still matches its line on the next verify
    expect(quoteMatches('  password: "pass"', "password: <redacted>")).toBe(true);
    expect(quoteMatches('  user: "pass"', "password: <redacted>")).toBe(false);
  });
  it("does not require a quote from a binary, a notebook or a minified line", () => {
    expect(quoteNotRequired("docs/logo.png", "x")).toBe(true);
    expect(quoteNotRequired("analysis.ipynb", "{")).toBe(true);
    expect(quoteNotRequired("dist/app.min.js", "a")).toBe(true);
    expect(quoteNotRequired("src/a.ts", "x".repeat(1001))).toBe(true);
    expect(quoteNotRequired("src/a.ts", "const a = 1;")).toBe(false);
  });
});

describe("secrets never land in a map", () => {
  it("refuses quotes from secret paths", () => {
    for (const p of [
      ".env",
      ".env.local",
      "config/secrets/db.yaml",
      "certs/server.key",
      "id_rsa.pem",
      "aws/credentials",
    ])
      expect(isSecretPath(p), p).toBe(true);
    for (const p of ["src/main/resources/application.yml", "k8s/deploy.yaml", "README.md"])
      expect(isSecretPath(p), p).toBe(false);
  });
  it("redacts a value after a secret-looking key, keeps the key", () => {
    expect(redactSecrets("password: hunter2")).toBe("password: <redacted>");
    expect(redactSecrets("api_key = 'abc123'")).toBe("api_key = <redacted>");
    expect(redactSecrets("token: ${VAULT_TOKEN}")).toBe("token: ${VAULT_TOKEN}");
    expect(redactSecrets("read-timeout: 1500ms")).toBe("read-timeout: 1500ms");
    expect(redactSecrets("-----BEGIN RSA PRIVATE KEY----- MIIE")).toBe("<redacted>");
  });
});
