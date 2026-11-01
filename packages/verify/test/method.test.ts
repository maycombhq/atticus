import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFacts, type Fact } from "@maycombhq/core";
import { dirSource, methodOnLines, methodUnseenOf, verifyFacts } from "../src/index.js";

/**
 * P2: the HTTP method an entry or call claims is looked for on its cited line, the next line, or
 * a `cite.with` line, in any language: a text check, no parser. A method found on none of them
 * is a note (a warning in the report, counted), never a rejection yet.
 */
describe("methodOnLines: the method written in the code, in any language", () => {
  const cases: [string, string, string[]][] = [
    ["GET", "Spring", ['@GetMapping("/tiers")']],
    [
      "POST",
      "Spring RequestMapping",
      ['@RequestMapping(value = "/x", method = RequestMethod.POST)'],
    ],
    ["GET", "ASP.NET", ['[HttpGet("{id}")]']],
    ["DELETE", "Express", ["router.delete('/notes/:id', remove);"]],
    ["PUT", "Flask, on the next line", ['@app.route("/limits/<id>",', '    methods=["PUT"])']],
    ["PATCH", "Go", ['r.HandleFunc("/x", h).Methods(http.MethodPatch)']],
    ["GET", "RestTemplate", ['return rest.getForObject(base + "/v1/rates/" + pair, Rate.class);']],
    ["POST", "fetch", ['await fetch(`/api/notes`, { method: "POST", body })']],
    ["GET", "Rails", ['get "/notes/:id", to: "notes#show"']],
    ["POST", "Next.js route handler", ["export async function POST(request: Request) {"]],
    ["GET", "Laravel", ["Route::get('/notes', [NoteController::class, 'index']);"]],
    ["POST", "Gin", ['r.POST("/notes", create)']],
    ["DELETE", "Go 1.22 pattern", ['mux.HandleFunc("DELETE /notes/{id}", remove)']],
    ["POST", "Ktor", ['post("/notes") {']],
    [
      "PUT",
      "Kotlin Spring, on the next line",
      ['@RequestMapping("/notes/{id}",', "  method = [RequestMethod.PUT])"],
    ],
    ["GET", "Express route chain", ["app.route('/notes').get(list).post(create);"]],
  ];
  for (const [method, what, lines] of cases)
    it(`finds ${method} in ${what}`, () => {
      expect(methodOnLines(method, lines)).toBe(true);
    });

  it("doesn't find a method the lines don't write, or one only inside a longer word", () => {
    expect(methodOnLines("PUT", ['@PostMapping("/checks")'])).toBe(false);
    expect(methodOnLines("GET", ["const target = budgets[0];"])).toBe(false);
    expect(methodOnLines("POST", ["const poster = load();", "postal.code = 1;"])).toBe(false);
  });

  it("is case-blind for the method as claimed", () => {
    expect(methodOnLines("get", ['@GetMapping("/tiers")'])).toBe(true);
  });
});

const FIX = join(__dirname, "..", "..", "..", "fixtures", "verify-read");
const repo = dirSource(join(FIX, "repo"));
const facts = (): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "forge-limits.facts.jsonl"), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const J = "src/main/java/forge/limits";

/** A fact of `kind` claiming `method`, cited at `file:line`. */
const claim = (kind: "entry" | "call", method: string, file: string, line: number, extra = {}) =>
  ({
    kind,
    id: `${kind}-x`,
    repo: "forge-notes",
    commit: "4d1c0de",
    ...(kind === "entry" ? { entryType: "rest" } : { callType: "rest" }),
    method,
    path: "/notes",
    cite: { file, line, value: "/notes" },
    verified: "line",
    by: "assistant",
    conf: "declared",
    ...extra,
  }) as Fact;

describe("methodUnseenOf: the lines a method may be written on (P2, measured)", () => {
  it("reads the whole chain a cited line continues: a fluent call's method above its .uri line", () => {
    const lines: Record<string, string[]> = {
      // Java's RestClient and WebClient, Kotlin's WebClient: the method opens the chain.
      "Client.java": [
        "  public View transfer(String id, Body body) {",
        "    return http.post()",
        '        .uri("/forge/v1/accounts/{id}/transfers", id)',
        "        .body(body)",
        "        .retrieve()",
        "        .body(View.class);",
      ],
      // Express: the route, then its methods, a line each.
      "notes.js": ["router", "  .route('/notes/:id')", "  .get(show)", "  .put(update);"],
      "Rates.java": [
        "    Rate a = rest.get(url);",
        "    Rate b = client",
        '        .uri("/v1/rates")',
      ],
    };
    const at = (p: string) => lines[p];
    expect(methodUnseenOf(claim("call", "POST", "Client.java", 3), at)).toBeUndefined();
    expect(methodUnseenOf(claim("entry", "PUT", "notes.js", 2), at)).toBeUndefined();
    // A chain doesn't reach past a statement that isn't part of it.
    expect(methodUnseenOf(claim("call", "GET", "Rates.java", 3), at)).toMatchObject({
      method: "GET",
    });
    expect(methodUnseenOf(claim("call", "GET", "Client.java", 3), at)).toMatchObject({
      method: "GET",
    });
  });

  it("takes a forwarding call's method from the route it forwards, when the two agree", () => {
    const lines: Record<string, string[]> = {
      "proxies/default.xml": [
        "<Flow>",
        '  <Condition>(proxy.pathsuffix MatchesPath "/transfers") and (request.verb = "POST")</Condition>',
      ],
      "policies/AM-Rewrite.xml": ["<AssignMessage>", "  <Set>", "    <Path>/transfers</Path>"],
    };
    const route = {
      ...claim("entry", "POST", "proxies/default.xml", 2),
      id: "entry.post.transfers",
    };
    const forward = claim("call", "POST", "policies/AM-Rewrite.xml", 3, {
      from: "entry.post.transfers",
    });
    const byId = (id: string) => (id === route.id ? route : undefined);
    expect(methodUnseenOf(forward, (p) => lines[p], byId)).toBeUndefined();
    // Without the route, or when the forward claims another method, the note stands.
    expect(methodUnseenOf(forward, (p) => lines[p])).toMatchObject({ method: "POST" });
    expect(
      methodUnseenOf({ ...forward, method: "PUT" } as Fact, (p) => lines[p], byId),
    ).toMatchObject({ method: "PUT" });
  });
});

describe("verifyFacts: a method its lines don't write is a note, never a rejection (P2)", () => {
  it("notes nothing when every method is on its line", async () => {
    const r = await verifyFacts({ facts: facts(), source: repo, commit: "4d1c0de" });
    expect(r.methodUnseen).toEqual([]);
  });

  it("notes an entry claiming a method its line doesn't write, and keeps the fact", async () => {
    const fs = facts().map((f) =>
      f.id === "e-post-check" && f.kind === "entry" ? { ...f, method: "PUT" } : f,
    );
    const r = await verifyFacts({ facts: fs, source: repo, commit: "4d1c0de" });
    expect(r.rejected).toEqual([]);
    expect(r.accepted.find((f) => f.id === "e-post-check")).toMatchObject({ method: "PUT" });
    expect(r.methodUnseen).toEqual([
      {
        id: "e-post-check",
        kind: "entry",
        method: "PUT",
        cite: `${J}/LimitController.java:18`,
        message: `e-post-check claims PUT, which neither ${J}/LimitController.java:18, the chain it is in, the next line, a cite.with line nor the route it forwards writes`,
      },
    ]);
  });

  it("finds a method on a cite.with line", () => {
    const lines: Record<string, string[]> = {
      "a.py": ['@app.route("/limits")', "def limits():"],
      "b.py": ["", "", 'METHODS = ["POST"]'],
    };
    const f = {
      kind: "entry",
      id: "e-limits",
      repo: "forge-limits",
      commit: "4d1c0de",
      entryType: "rest",
      method: "POST",
      path: "/limits",
      cite: {
        file: "a.py",
        line: 1,
        value: "/limits",
        with: [{ file: "b.py", line: 3, value: "POST" }],
      },
      verified: "line",
      by: "assistant",
      conf: "declared",
    } as Fact;
    expect(methodUnseenOf(f, (p) => lines[p])).toBeUndefined();
    const { with: _w, ...cite } = (f as Extract<Fact, { kind: "entry" }>).cite;
    expect(methodUnseenOf({ ...f, cite } as Fact, (p) => lines[p])).toMatchObject({
      id: "e-limits",
      method: "POST",
    });
  });
});
