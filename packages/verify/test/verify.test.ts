import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFacts, type Fact } from "@maycombhq/core";
import {
  dirSource,
  entriesNoFlowFollows,
  isCommentLine,
  memorySource,
  verifyFacts,
} from "../src/index.js";

const fixtures = join(__dirname, "fixtures");
const repo = join(fixtures, "repo");
const load = (name: string): Fact[] => {
  const r = parseFacts(readFileSync(join(fixtures, name), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};

describe("verifyFacts: the claim on the cited line (ADR 0124)", () => {
  it("accepts every fact of a correct read, and marks each verified by the line check", async () => {
    const facts = load("forge-ledger.facts.jsonl");
    const r = await verifyFacts({ facts, source: dirSource(repo), commit: "0123abc" });
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toHaveLength(17);
    for (const f of r.accepted) expect(f.verified).toBe("line");
  });

  it("rejects every fabricated or misplaced citation in the red-team file, each with its reason", async () => {
    const facts = [...load("forge-ledger.facts.jsonl"), ...load("redteam.facts.jsonl")];
    const r = await verifyFacts({ facts, source: dirSource(repo), commit: "0123abc" });
    const why = Object.fromEntries(r.rejected.map((x) => [x.fact.id, x.code]));
    expect(why).toEqual({
      "rt-no-file": "no-file",
      "rt-past-end": "no-line",
      "rt-wrong-line": "claim-not-on-line",
      "rt-invented-path": "claim-not-on-line",
      "rt-invented-table": "claim-not-on-line",
      "rt-invented-field": "claim-not-on-line",
      "rt-quote-mismatch": "quote-mismatch",
      "rt-dangling": "dangling-ref",
      "rt-secret-path": "secret-path",
      "rt-wrong-commit": "wrong-commit",
      "rt-traversal": "outside-repo",
    });
    expect(r.accepted).toHaveLength(17);
    for (const x of r.rejected) expect(x.message.length).toBeGreaterThan(10);
  });

  it("a fact that names a rejected fact is rejected too", async () => {
    const facts = load("forge-ledger.facts.jsonl").map((f) =>
      f.id === "e-post-entry" ? { ...f, cite: { ...f.cite, line: 3 } } : f,
    );
    const r = await verifyFacts({ facts, source: dirSource(repo), commit: "0123abc" });
    const ids = r.rejected.map((x) => `${x.fact.id}:${x.code}`).sort();
    expect(ids).toEqual(
      [
        "e-post-entry:claim-not-on-line",
        "f-entry-amount:ref-rejected",
        "f-entry-currency:ref-rejected",
        "w-post-entry:ref-rejected",
        "c-fx-rate:ref-rejected",
        "c-notify:ref-rejected",
        "s-entry-write:ref-rejected",
        "f-col-amount:ref-rejected",
        "f-col-account-id:ref-rejected",
        "f-fx-pair:ref-rejected",
      ].sort(),
    );
  });

  it("forgives the model's small rewrites of a quote, and needs none from a minified line", async () => {
    const facts = load("forge-ledger.facts.jsonl").map((f) =>
      f.id === "c-fx-rate"
        ? {
            ...f,
            cite: {
              ...f.cite,
              quote: "return rest.getForObject(base + '/v1/rates/' + pair, Rate.class).",
            },
          }
        : f,
    );
    const r = await verifyFacts({ facts, source: dirSource(repo), commit: "0123abc" });
    expect(r.rejected).toEqual([]);
    const min = memorySource({ "dist/app.min.js": `${"x".repeat(1200)}fetch("/api/v2/orders")` });
    const one = await verifyFacts({
      source: min,
      facts: [
        {
          kind: "call",
          id: "c-min",
          repo: "web",
          commit: "0123abc",
          callType: "rest",
          method: "GET",
          path: "/api/v2/orders",
          to: "orders",
          cite: {
            file: "dist/app.min.js",
            line: 1,
            value: "/api/v2/orders",
            quote: "no such text",
          },
          verified: "none",
          by: "assistant",
          conf: "declared",
        },
      ],
    });
    expect(one.rejected).toEqual([]);
  });

  it("redacts a secret value in a stored quote and never keeps a value as a fact", async () => {
    const src = memorySource({ "config/app.yml": "db:\n  password: s3cr3t\n" });
    const r = await verifyFacts({
      source: src,
      facts: [
        {
          kind: "config",
          id: "k-pw",
          repo: "x",
          commit: "0123abc",
          settingKind: "config",
          key: "db.password",
          source: "config/app.yml",
          cite: { file: "config/app.yml", line: 2, value: "password", quote: "password: s3cr3t" },
          verified: "none",
          by: "assistant",
          conf: "declared",
        },
      ],
    });
    expect(r.rejected).toEqual([]);
    expect(r.accepted[0]!.cite.quote).toBe("password: <redacted>");
    expect(r.redacted).toBe(1);
  });

  // Review round 47: a secret mid-line is redacted; a quote that still holds a literal beside a
  // secret word redaction couldn't place is dropped, and ordinary code keeps its quote.
  it("redacts a secret anywhere on the line, drops a quote it can't redact, keeps plain code", async () => {
    const src = memorySource({
      "src/Creds.java": [
        "class Creds {",
        '  private static final String password = "hunter22";',
        '  void fill() { creds.put(PASSWORD_KEY, "Xk9fQ2mZ7p"); }',
        "  String hash(String raw) { return passwordEncoder.encode(raw); }",
        "}",
      ].join("\n"),
    });
    const fact = (id: string, line: number, value: string, quote: string) => ({
      kind: "config" as const,
      id,
      repo: "x",
      commit: "0123abc",
      settingKind: "config" as const,
      key: value,
      source: "src/Creds.java",
      cite: { file: "src/Creds.java", line, value, quote },
      verified: "none" as const,
      by: "assistant" as const,
      conf: "declared" as const,
    });
    const r = await verifyFacts({
      source: src,
      facts: [
        fact("k-a", 2, "password", 'private static final String password = "hunter22";'),
        fact("k-b", 3, "PASSWORD_KEY", 'creds.put(PASSWORD_KEY, "Xk9fQ2mZ7p");'),
        fact("k-c", 4, "passwordEncoder", "return passwordEncoder.encode(raw);"),
      ],
    });
    expect(r.rejected).toEqual([]);
    const quote = (id: string) => r.accepted.find((f) => f.id === id)!.cite.quote;
    expect(quote("k-a")).toBe("private static final String password = <redacted>");
    expect(quote("k-b")).toBeUndefined();
    expect(quote("k-c")).toBe("return passwordEncoder.encode(raw);");
    expect(r.redacted).toBe(2);
  });

  it("keeps a person's verification on a fact a person made, never on one the reader marked itself", async () => {
    const facts = load("forge-ledger.facts.jsonl").map((f) =>
      f.id === "d-prod"
        ? { ...f, by: "person" as const, verified: "person" as const }
        : f.id === "k-fx-base"
          ? { ...f, verified: "person" as const }
          : f,
    );
    const r = await verifyFacts({ facts, source: dirSource(repo), commit: "0123abc" });
    expect(r.accepted.find((f) => f.id === "d-prod")!.verified).toBe("person");
    expect(r.accepted.find((f) => f.id === "k-fx-base")!.verified).toBe("line");
  });
});

describe("a flow's call-out step names its call (B-fixes, problem 6)", () => {
  /** w-post-entry with its call-out step (step 2) given another ref, or none. */
  const withCallOutRef = (ref: string | undefined) =>
    load("forge-ledger.facts.jsonl").map((f) => {
      if (f.id !== "w-post-entry" || f.kind !== "flow") return f;
      return {
        ...f,
        steps: f.steps.map((s) => {
          if (s.kind !== "call-out" || s.ref !== "c-fx-rate") return s;
          const { ref: _ref, ...rest } = s;
          return ref === undefined ? rest : { ...rest, ref };
        }),
      } as Fact;
    });
  const verdict = async (facts: Fact[]) =>
    (await verifyFacts({ facts, source: dirSource(repo), commit: "0123abc" })).rejected.find(
      (x) => x.fact.id === "w-post-entry",
    );

  it("rejects a call-out step that names no fact, saying which step and what to name", async () => {
    const r = await verdict(withCallOutRef(undefined));
    expect(r?.code).toBe("call-out-no-call");
    expect(r?.message).toMatch(/step 2/);
    expect(r?.message).toMatch(/call fact/);
    expect(r?.message).toMatch(/config fact/);
  });

  it("rejects a call-out step whose ref is a store or a field", async () => {
    expect((await verdict(withCallOutRef("s-entry-write")))?.code).toBe("call-out-no-call");
    expect((await verdict(withCallOutRef("f-entry-amount")))?.code).toBe("call-out-no-call");
  });

  it("takes a call-out step whose ref is a call fact, or a config fact (an SDK client with no path)", async () => {
    expect(await verdict(withCallOutRef("c-fx-rate"))).toBeUndefined();
    expect(await verdict(withCallOutRef("k-fx-base"))).toBeUndefined();
  });
});

/**
 * The estate fixes (ADR 0124 addendum C-estate): a publish step names the event it publishes, and
 * the entries no flow starts are listed for the reader to follow.
 */
describe("a flow's publish step names its event, and the entries no flow follows are listed", () => {
  const src = memorySource({
    "src/OrderController.java": [
      "public class OrderController {",
      '  @PostMapping("/orders")',
      "  public ResponseEntity<Order> place(@RequestBody Order o) {",
      '    audit.post("http://audit.internal/audit", o);',
      '    events.send("forge.orders.placed", o);',
      "    return ResponseEntity.status(201).body(o);",
      "  }",
      '  @GetMapping("/orders/{id}")',
      "  public Order get(@PathVariable String id) { return repo.find(id); }",
      '  @Scheduled(cron = "0 0 * * * *")',
      "  public void purge() { repo.purge(); }",
      "}",
      "",
    ].join("\n"),
    "src/OrderListener.java": [
      "public class OrderListener {",
      '  @KafkaListener(topics = "forge.orders.placed")',
      "  public void on(Order o) { }",
      "}",
      "",
    ].join("\n"),
  });
  const base = {
    repo: "forge-orders",
    commit: "0123abc",
    component: "orders-api",
    verified: "none" as const,
    by: "assistant" as const,
    conf: "declared" as const,
  };
  const at = (file: string, line: number, value: string) => ({
    file: `src/${file}.java`,
    line,
    value,
  });
  const facts = (publishRef: string | undefined, eventType = "event-topic"): Fact[] => [
    {
      ...base,
      kind: "entry",
      id: "e-post-orders",
      entryType: "rest",
      method: "POST",
      path: "/orders",
      cite: at("OrderController", 2, "/orders"),
    },
    {
      ...base,
      kind: "entry",
      id: "e-get-order",
      entryType: "rest",
      method: "GET",
      path: "/orders/{id}",
      cite: at("OrderController", 8, "/orders/{id}"),
    },
    {
      ...base,
      kind: "entry",
      id: "e-purge",
      entryType: "batch-job",
      path: "purge",
      cite: at("OrderController", 11, "purge"),
    },
    {
      ...base,
      kind: "entry",
      id: "e-on-placed",
      entryType: "event-topic",
      path: "forge.orders.placed",
      handler: "OrderListener.on",
      cite: at("OrderListener", 2, "forge.orders.placed"),
    },
    {
      ...base,
      kind: "call",
      id: "c-audit",
      callType: "rest",
      method: "POST",
      path: "/audit",
      host: "audit.internal",
      cite: at("OrderController", 4, "/audit"),
    },
    {
      ...base,
      kind: "call",
      id: "c-placed",
      callType: eventType as "event-topic",
      path: "forge.orders.placed",
      cite: at("OrderController", 5, "forge.orders.placed"),
    },
    {
      ...base,
      kind: "flow",
      id: "w-place",
      name: "Place an order",
      entry: "e-post-orders",
      steps: [
        {
          kind: "call-out",
          what: "the audit service is told",
          ref: "c-audit",
          cite: at("OrderController", 4, "/audit"),
        },
        {
          kind: "publish",
          what: "the order placed event is published",
          ...(publishRef ? { ref: publishRef } : {}),
          cite: at("OrderController", 5, "forge.orders.placed"),
        },
        { kind: "respond", what: "201", cite: at("OrderController", 6, "201") },
      ],
      errors: [],
      cite: at("OrderController", 2, "/orders"),
    },
  ];
  const run = (f: Fact[]) => verifyFacts({ facts: f, source: src, commit: "0123abc" });

  it("takes a publish step whose ref is the event-topic or mq-queue call it publishes", async () => {
    expect((await run(facts("c-placed"))).rejected).toEqual([]);
    expect((await run(facts("c-placed", "mq-queue"))).rejected).toEqual([]);
  });

  it("rejects a publish step that names no fact, or a call that isn't an event, saying which step and what to name", async () => {
    for (const ref of [undefined, "c-audit", "e-on-placed"]) {
      const r = (await run(facts(ref))).rejected.find((x) => x.fact.id === "w-place");
      expect(r?.code).toBe("publish-no-event");
      expect(r?.message).toMatch(/step 2/);
      expect(r?.message).toMatch(/event-topic/);
      expect(r?.message).toMatch(/mq-queue/);
      expect(r?.message).toMatch(/OrderController\.java:5/);
    }
  });

  it("lists the listeners and the rest or gRPC entries no flow starts, a note and not a rejection", async () => {
    const r = await run(facts("c-placed"));
    expect(r.rejected).toEqual([]);
    // The batch job isn't listed (only listeners and rest/grpc); e-post-orders has its flow.
    expect(r.entriesNoFlowFollows).toEqual([
      {
        id: "e-get-order",
        entryType: "rest",
        method: "GET",
        path: "/orders/{id}",
        cite: "src/OrderController.java:8",
      },
      {
        id: "e-on-placed",
        entryType: "event-topic",
        path: "forge.orders.placed",
        cite: "src/OrderListener.java:2",
      },
    ]);
  });

  it("names the same entries from the facts alone (entriesNoFlowFollows)", () => {
    expect(entriesNoFlowFollows(facts("c-placed")).map((e) => e.id)).toEqual([
      "e-get-order",
      "e-on-placed",
    ]);
  });
});

describe("a claim put together from several lines (ADR 0124 addendum A4)", () => {
  const src = memorySource({
    "src/environments/environment.ts":
      "export const environment = {\n  REST_API_URL: 'http://localhost:9966/petclinic/api/'\n};\n",
    "src/app/owners/owner.service.ts":
      "export class OwnerService {\n  entityUrl = environment.REST_API_URL + 'owners';\n  getOwnerById(ownerId: string) {\n    return this.http.get<Owner>((this.entityUrl + '/' + ownerId));\n  }\n}\n",
  });
  const call = (path: string, withParts: { file: string; line: number; value: string }[]) => ({
    kind: "call" as const,
    id: "c",
    repo: "web",
    commit: "0123abc",
    callType: "rest" as const,
    method: "GET",
    path,
    to: "api",
    cite: { file: "src/app/owners/owner.service.ts", line: 4, value: "entityUrl", with: withParts },
    verified: "none" as const,
    by: "assistant" as const,
    conf: "declared" as const,
  });
  it("accepts a path whose parts are each written on a cited line", async () => {
    const r = await verifyFacts({
      source: src,
      facts: [
        call("/petclinic/api/owners/{ownerId}", [
          { file: "src/environments/environment.ts", line: 2, value: "/petclinic/api/" },
          { file: "src/app/owners/owner.service.ts", line: 2, value: "owners" },
        ]),
      ],
    });
    expect(r.rejected).toEqual([]);
    expect(r.coverage.read).toContain("src/environments/environment.ts");
  });
  it("rejects a part that isn't on its line, and a path with a part written nowhere", async () => {
    const bad = await verifyFacts({
      source: src,
      facts: [
        call("/petclinic/api/owners/{id}", [
          { file: "src/environments/environment.ts", line: 2, value: "/vets/" },
        ]),
      ],
    });
    expect(bad.rejected[0]?.code).toBe("claim-not-on-line");
    const nowhere = await verifyFacts({
      source: src,
      facts: [
        call("/petclinic/api/visits/{id}", [
          { file: "src/environments/environment.ts", line: 2, value: "/petclinic/api/" },
          { file: "src/app/owners/owner.service.ts", line: 2, value: "owners" },
        ]),
      ],
    });
    expect(nowhere.rejected[0]?.code).toBe("claim-not-on-line");
  });
});

describe("a conventional route: the controller, the action and the route template (A4)", () => {
  const src = memorySource({
    "App_Start/RouteConfig.cs":
      'public class RouteConfig {\n  public static void Register(RouteCollection routes) {\n    routes.MapRoute(name: "Default", url: "{controller}/{action}/{id}");\n  }\n}\n',
    "Controllers/CatalogController.cs":
      "public class CatalogController : Controller {\n  [HttpPost]\n  public ActionResult Create(CatalogItem item) {\n    return View();\n  }\n}\n",
  });
  const entry = (path: string) => ({
    kind: "entry" as const,
    id: "e",
    repo: "web",
    commit: "0123abc",
    entryType: "rest" as const,
    method: "POST",
    path,
    cite: {
      file: "Controllers/CatalogController.cs",
      line: 3,
      value: "Create",
      with: [
        { file: "Controllers/CatalogController.cs", line: 1, value: "CatalogController" },
        { file: "App_Start/RouteConfig.cs", line: 3, value: "{controller}/{action}/{id}" },
      ],
    },
    verified: "none" as const,
    by: "assistant" as const,
    conf: "declared" as const,
  });
  it("accepts /Catalog/Create from the action, its controller and the template", async () => {
    const r = await verifyFacts({ source: src, facts: [entry("/Catalog/Create")] });
    expect(r.rejected).toEqual([]);
  });
  it("rejects an action the controller doesn't have", async () => {
    const r = await verifyFacts({ source: src, facts: [entry("/Catalog/Delete")] });
    expect(r.rejected[0]?.code).toBe("claim-not-on-line");
  });
});

describe("what the revised reads found about the verifier (A4)", () => {
  const base = {
    repo: "web",
    commit: "0123abc",
    verified: "none" as const,
    by: "assistant" as const,
    conf: "declared" as const,
  };
  it("takes a part named at a camelCase start, as the path check does", async () => {
    const src = memorySource({
      "Controllers/CatalogController.cs":
        "public class CatalogController : Controller {\n  public ActionResult Details(int id) {\n    return View();\n  }\n}\n",
      "App_Start/RouteConfig.cs":
        'routes.MapRoute(name: "Default", url: "{controller}/{action}/{id}");\n',
    });
    const r = await verifyFacts({
      source: src,
      facts: [
        {
          ...base,
          kind: "entry",
          id: "e",
          entryType: "rest",
          method: "GET",
          path: "/Catalog/Details/{id}",
          cite: {
            file: "Controllers/CatalogController.cs",
            line: 2,
            value: "Details",
            with: [
              { file: "Controllers/CatalogController.cs", line: 1, value: "Catalog" },
              { file: "App_Start/RouteConfig.cs", line: 1, value: "{controller}/{action}/{id}" },
            ],
          },
        },
      ],
    });
    expect(r.rejected).toEqual([]);
  });
  it("takes a root path with a parameter concatenated in code", async () => {
    const src = memorySource({
      "shipping/quote.go": 'url := packagingServiceUrl + "/" + productId\n',
    });
    const r = await verifyFacts({
      source: src,
      facts: [
        {
          ...base,
          kind: "call",
          id: "c",
          callType: "rest",
          method: "GET",
          path: "/{productId}",
          to: "packaging",
          cite: { file: "shipping/quote.go", line: 1, value: "/" },
        },
      ],
    });
    expect(r.rejected).toEqual([]);
  });
  it("rejects a claim only written in a comment", async () => {
    const src = memorySource({
      "deploy/cluster.xml":
        '<Parameters>\n  <!-- <Parameter Name="ClusterName" Value="mycluster.westus" /> -->\n  <Parameter Name="ClusterName" Value="forge-cluster" />\n</Parameters>\n',
      "src/Api.cs": "// GET: api/vets\npublic IActionResult Vets() => Ok();\n",
    });
    const r = await verifyFacts({
      source: src,
      facts: [
        {
          ...base,
          kind: "deploy",
          id: "d-bad",
          platform: "service-fabric",
          resourceName: "mycluster.westus",
          cite: { file: "deploy/cluster.xml", line: 2, value: "mycluster.westus" },
        },
        {
          ...base,
          kind: "deploy",
          id: "d-good",
          platform: "service-fabric",
          resourceName: "forge-cluster",
          cite: { file: "deploy/cluster.xml", line: 3, value: "forge-cluster" },
        },
        {
          ...base,
          kind: "entry",
          id: "e-comment",
          entryType: "rest",
          method: "GET",
          path: "/api/vets",
          cite: { file: "src/Api.cs", line: 1, value: "api/vets" },
        },
      ],
    });
    expect(r.rejected.map((x) => [x.fact.id, x.code])).toEqual([
      ["d-bad", "claim-in-comment"],
      ["e-comment", "claim-in-comment"],
    ]);
    expect(r.accepted.map((f) => f.id)).toEqual(["d-good"]);
  });

  // Review of ADR 0196 (the canary's first finding): a `cite.with` part whose value only a
  // commented-out line beside it holds is no code either, and neither is a comment line beside
  // the main cite that a route's parts would otherwise be found on.
  describe("a cite.with part beside a commented-out old route", () => {
    const src = memorySource({
      "src/main/java/forge/portal/TransferClient.java": [
        "package forge.portal;", // 1
        "", // 2
        "import org.springframework.web.bind.annotation.*;", // 3
        "", // 4
        '@FeignClient(name = "ledger", url = "${gateway.url}/ledger/v1")', // 5
        "public interface TransferClient {", // 6
        '  // @PostMapping("/transfers")', // 7
        "  TransferResult createTransfer(@RequestBody TransferRequest request);", // 8
        "", // 9
        '  // @GetMapping("/allowances")', // 10
        '  @GetMapping("/limits")', // 11
        "  Limits limits();", // 12
        "}", // 13
        "",
      ].join("\n"),
    });
    const call = (
      id: string,
      path: string,
      line: number,
      value: string,
      parts: [number, string][],
    ) =>
      ({
        ...base,
        kind: "call",
        id,
        callType: "rest",
        method: "POST",
        path,
        cite: {
          file: "src/main/java/forge/portal/TransferClient.java",
          line,
          value,
          with: parts.map(([l, v]) => ({
            file: "src/main/java/forge/portal/TransferClient.java",
            line: l,
            value: v,
          })),
        },
      }) as Fact;

    it("rejects a part named only on the comment, and keeps the live route beside it", async () => {
      const r = await verifyFacts({
        source: src,
        facts: [
          call("c-old", "/ledger/v1/transfers", 8, "createTransfer", [
            [5, "/ledger/v1"],
            [8, "/transfers"],
          ]),
          call("c-old-allowances", "/ledger/v1/allowances", 12, "limits", [
            [5, "/ledger/v1"],
            [11, "/allowances"],
          ]),
          call("c-live", "/ledger/v1/limits", 12, "limits", [
            [5, "/ledger/v1"],
            [11, "/limits"],
          ]),
        ],
      });
      expect(r.rejected.map((x) => [x.fact.id, x.code])).toEqual([
        ["c-old", "claim-in-comment"],
        ["c-old-allowances", "claim-in-comment"],
      ]);
      expect(r.rejected[0]!.message).toMatch(/part 2 .*comment/);
      expect(r.accepted.map((f) => f.id)).toEqual(["c-live"]);
    });

    it("finds no route part on a comment line beside the main cite", async () => {
      // `transfers` is only on line 7, a comment beside the cited line 8: the parts name the rest
      const r = await verifyFacts({
        source: src,
        facts: [call("c-near", "/ledger/v1/transfers", 8, "createTransfer", [[5, "/ledger/v1"]])],
      });
      expect(r.rejected.map((x) => x.code)).toEqual(["claim-in-comment"]);
    });
  });

  // Second review of ADR 0196: with parts, what they don't name the cited lines write as a path,
  // not as an identifier; an attribute (`#[Route]`, `#[get]`) is code, and so is a line after a
  // block comment closed on it. Each case is the reviewer's probe, in Forge's names.
  describe("parts, attributes and comment-like code (second review of ADR 0196)", () => {
    const entry = (
      id: string,
      file: string,
      path: string,
      line: number,
      value: string,
      parts: [number, string][] = [],
    ) =>
      ({
        ...base,
        kind: "entry",
        id,
        entryType: "rest",
        method: "GET",
        path,
        cite: {
          file,
          line,
          value,
          ...(parts.length ? { with: parts.map(([l, v]) => ({ file, line: l, value: v })) } : {}),
        },
      }) as Fact;
    const one = async (files: Record<string, string>, f: Fact) => {
      const r = await verifyFacts({ source: memorySource(files), facts: [f] });
      return r.rejected[0]?.code ?? "kept";
    };
    const java = {
      "src/main/java/forge/portal/BalanceResource.java": [
        "@RestController", // 1
        '@RequestMapping("/api")', // 2
        "class BalanceResource {", // 3
        '  // @GetMapping("/balances")', // 4
        "  public List<Balance> balances() { return null; }", // 5
        "}",
        "",
      ].join("\n"),
    };
    const J = "src/main/java/forge/portal/BalanceResource.java";

    it("refuses a method name under a commented-out mapping, with the class prefix a part", async () => {
      expect(await one(java, entry("s1", J, "/api/balances", 5, "balances", [[2, "/api"]]))).toBe(
        "claim-in-comment",
      );
      expect(await one(java, entry("s2", J, "/balances", 5, "balances"))).toBe("claim-in-comment");
      expect(await one(java, entry("s3", J, "/balances", 4, "/balances"))).toBe("claim-in-comment");
    });

    it("keeps a live mapping beside it, and a route string after a block comment", async () => {
      const live = {
        [J]: java[J].replace('  // @GetMapping("/balances")', '  @GetMapping("/balances")'),
      };
      expect(await one(live, entry("l1", J, "/api/balances", 5, "balances", [[2, "/api"]]))).toBe(
        "kept",
      );
      const js = {
        "src/routes.js": [
          "const express = require('express');",
          "const router = express.Router();",
          "/* istanbul ignore next */ router.get('/users', list);",
          "app.use('/api', router);",
        ].join("\n"),
      };
      expect(
        await one(js, entry("j1", "src/routes.js", "/api/users", 3, "/users", [[4, "/api"]])),
      ).toBe("kept");
    });

    it("reads a PHP 8 or Rust attribute as code, not a comment", async () => {
      const php = {
        "src/Controller/UserController.php": [
          "<?php", // 1
          "namespace Forge\\Controller;", // 2
          "", // 3
          "#[Route('/api')]", // 4
          "class UserController extends AbstractController", // 5
          "{", // 6
          "    #[Route('/users', methods: ['GET'])]", // 7
          "    public function list(): Response", // 8
          "    {", // 9
          "    }",
          "}",
          "",
        ].join("\n"),
      };
      const P = "src/Controller/UserController.php";
      expect(await one(php, entry("p1", P, "/api/users", 7, "/users", [[4, "/api"]]))).toBe("kept");
      // Symfony: the class-level prefix a part, the method's line cited
      expect(await one(php, entry("p2", P, "/api/users", 8, "list", [[4, "/api"]]))).toBe("kept");
      expect(await one(php, entry("p3", P, "/users", 7, "/users"))).toBe("kept");
      const rs = {
        "src/main.rs": [
          "use actix_web::{get, web, App};",
          "",
          '#[get("/users")]',
          'async fn users() -> impl Responder { "" }',
          "",
          "fn main() {",
          '    App::new().service(web::scope("/api").service(users));',
          "}",
          "",
        ].join("\n"),
      };
      expect(
        await one(rs, entry("r1", "src/main.rs", "/api/users", 3, "/users", [[7, "/api"]])),
      ).toBe("kept");
      expect(
        await one(rs, entry("r2", "src/main.rs", "/api/users", 4, "users", [[7, "/api"]])),
      ).toBe("kept");
      expect(isCommentLine("#[Route('/x')]", "src/A.php")).toBe(false);
      expect(isCommentLine('  #[get("/x")]', "src/main.rs")).toBe(false);
      expect(isCommentLine("/* a */ router.get('/x')", "src/a.js")).toBe(false);
      expect(isCommentLine("/* a */ // b", "src/a.js")).toBe(true);
      expect(isCommentLine("# a comment", "app/main.py")).toBe(true);
      expect(isCommentLine("#!/bin/sh", "bin/run.sh")).toBe(false);
      // third review: `#[` is an attribute only in PHP and Rust; elsewhere it opens a comment
      expect(isCommentLine('#[app.get("/balances")]', "app/main.py")).toBe(true);
      expect(isCommentLine("#[1] see the ledger notes", "config/routes.rb")).toBe(true);
      expect(isCommentLine("#[draft] url: /balances", "config/app.yaml")).toBe(true);
    });
  });

  // Third review of ADR 0196: the as-a-path rule lost correct facts on real repos (gRPC, WCF,
  // conventional MVC routes, interpolation, .asmx, NSwag clients, DRF actions, constant paths).
  // It now applies only to an HTTP route whose missing piece a commented-out mapping in the cite
  // window writes as a path. Each shape below is the bench's, in invented Forge/Northwind names.
  describe("route facts with parts across frameworks (third review of ADR 0196)", () => {
    type P = [file: string, line: number, value: string];
    const fact = (
      id: string,
      kind: "entry" | "call",
      type: string,
      path: string,
      cite: P,
      parts: P[],
      method: string | undefined = "GET",
    ) =>
      ({
        ...base,
        kind,
        id,
        ...(kind === "entry" ? { entryType: type } : { callType: type }),
        ...(method ? { method } : {}),
        path,
        cite: {
          file: cite[0],
          line: cite[1],
          value: cite[2],
          with: parts.map(([file, line, value]) => ({ file, line, value })),
        },
      }) as Fact;
    const one = async (files: Record<string, string>, f: Fact) => {
      const r = await verifyFacts({ source: memorySource(files), facts: [f] });
      return r.rejected[0]?.code ?? "kept";
    };
    const lines = (...ls: string[]) => [...ls, ""].join("\n");

    const PROTO = "proto/ledger/v1/ledger.proto";
    const proto = lines(
      'syntax = "proto3";', // 1
      "package ledger;", // 2
      "", // 3
      "service LedgerService {", // 4
      "  // Called as /ledger.LedgerService/PostEntry by the portal.", // 5
      "  rpc PostEntry(PostEntryRequest) returns (PostEntryReply) {}", // 6
      "}", // 7
    );

    it("keeps a gRPC entry on its proto's rpc, with the package and the service as parts", async () => {
      const f = fact(
        "g1",
        "entry",
        "grpc",
        "ledger.LedgerService/PostEntry",
        [PROTO, 6, "PostEntry"],
        [
          [PROTO, 2, "ledger"],
          [PROTO, 4, "LedgerService"],
        ],
        undefined,
      );
      expect(await one({ [PROTO]: proto }, f)).toBe("kept");
    });

    it("keeps gRPC calls on a Go stub and a C# override", async () => {
      const go = {
        [PROTO]: proto,
        "internal/portal/ledger_client.go": lines(
          "func (c Client) Post(ctx context.Context) error {", // 1
          "\t_, err := c.ledger.PostEntry(ctx, &ledger.PostEntryRequest{})", // 2
          "\treturn err", // 3
          "}", // 4
        ),
      };
      const parts: P[] = [
        [PROTO, 2, "ledger"],
        [PROTO, 4, "LedgerService"],
      ];
      expect(
        await one(
          go,
          fact(
            "g2",
            "call",
            "grpc",
            "ledger.LedgerService/PostEntry",
            ["internal/portal/ledger_client.go", 2, "PostEntry"],
            parts,
            undefined,
          ),
        ),
      ).toBe("kept");
      const cs = {
        [PROTO]: proto,
        "src/Ledger.Api/Grpc/LedgerService.cs": lines(
          "public class LedgerService : Ledger.LedgerServiceBase", // 1
          "{", // 2
          "    // POST /ledger.LedgerService/PostEntry", // 3
          "    public override async Task<PostEntryReply> PostEntry(PostEntryRequest request, ServerCallContext context)", // 4
          "    {", // 5
          "    }", // 6
          "}", // 7
        ),
      };
      expect(
        await one(
          cs,
          fact(
            "g3",
            "entry",
            "grpc",
            "ledger.LedgerService/PostEntry",
            ["src/Ledger.Api/Grpc/LedgerService.cs", 4, "PostEntry"],
            parts,
            undefined,
          ),
        ),
      ).toBe("kept");
    });

    it("keeps a WCF call through its service contract and endpoint", async () => {
      const files = {
        "src/Northwind.Desk/Controllers/LedgerController.cs": lines(
          "public class LedgerController", // 1
          "{", // 2
          "    private readonly ILedgerService _service;", // 3
          "", // 4
          "", // 5
          "    public void Load()", // 6
          "    {", // 7
          "        // SOAP: GetBalance", // 8
          "        var balance = _service.GetBalance(DateTime.Now);", // 9
          "    }", // 10
          "}", // 11
        ),
        "src/Northwind.Desk/App.config": lines(
          "<configuration>", // 1
          '  <endpoint address="http://localhost:5100/LedgerService.svc" binding="basicHttpBinding" contract="ILedgerService" />', // 2
          "</configuration>", // 3
        ),
      };
      const f = fact(
        "w1",
        "call",
        "soap",
        "ILedgerService/GetBalance",
        ["src/Northwind.Desk/Controllers/LedgerController.cs", 9, "GetBalance"],
        [
          ["src/Northwind.Desk/Controllers/LedgerController.cs", 3, "ILedgerService"],
          ["src/Northwind.Desk/App.config", 2, "http://localhost:5100/LedgerService.svc"],
        ],
        undefined,
      );
      expect(await one(files, f)).toBe("kept");
    });

    describe("ASP.NET MVC conventional routes, the scaffold's comments beside them", () => {
      const C = "src/Northwind.Web/Controllers/StatementController.cs";
      const controller = lines(
        "using Microsoft.AspNetCore.Mvc;", // 1
        "", // 2
        "public class StatementController : Controller", // 3
        "{", // 4
        "", // 5
        "    // GET: Statement/Create", // 6
        "    public ActionResult Create()", // 7
        "    {", // 8
        "        return View();", // 9
        "    }", // 10
        "", // 11
        "    // POST: Statement/Edit/5", // 12
        "    [HttpPost]", // 13
        "    public ActionResult Edit(StatementItem item)", // 14
        "    {", // 15
        "        return View(item);", // 16
        "    }", // 17
        "}", // 18
      );
      const forms: [string, string, string][] = [
        [
          "a template with defaults",
          "src/Northwind.Web/Startup.cs",
          '            endpoints.MapControllerRoute("default", "{controller=Statement}/{action=Index}/{id?}");',
        ],
        [
          "MapControllerRoute with a pattern",
          "src/Northwind.Web/Program.cs",
          'app.MapControllerRoute(name: "default", pattern: "{controller=Home}/{action=Index}/{id?}");',
        ],
        [
          "MapDefaultControllerRoute",
          "src/Northwind.Web/Program.cs",
          "app.MapDefaultControllerRoute();",
        ],
        [
          "MVC 5's MapRoute",
          "src/Northwind.Web/App_Start/RouteConfig.cs",
          '            routes.MapRoute(name: "Default", url: "{controller}/{action}/{id}");',
        ],
      ];
      for (const [name, file, text] of forms)
        it(`keeps an action under its scaffold comment: ${name}`, async () => {
          const files = { [C]: controller, [file]: lines("", text, "") };
          const value = /\{controller[^"]*/.exec(text)?.[0] ?? /\w*Map\w+Route/.exec(text)![0];
          const parts: P[] = [
            [C, 3, "StatementController"],
            [file, 2, value],
          ];
          expect(
            await one(
              files,
              fact("m1", "entry", "rest", "/Statement/Create", [C, 7, "Create"], parts),
            ),
          ).toBe("kept");
          expect(
            await one(
              files,
              fact("m2", "entry", "rest", "/Statement/Edit", [C, 14, "Edit"], parts, "POST"),
            ),
          ).toBe("kept");
        });
    });

    it("keeps a path a string interpolation puts after its base (C#, JS, Python, Kotlin)", async () => {
      const shapes: [string, string][] = [
        [
          "src/Northwind.Web/Services/StatementService.cs",
          '        var uri = $"{_baseUrl}statements";',
        ],
        ["src/portal/statements.js", "  const res = await fetch(`${baseUrl}statements`);"],
        ["portal/statements.py", '    r = httpx.get(f"{BASE_URL}statements")'],
        [
          "src/main/kotlin/forge/Statements.kt",
          '        val res = client.get("${baseUrl}statements")',
        ],
      ];
      for (const [file, line] of shapes) {
        // a doc comment above names the whole path: the code's interpolated string still writes it
        const files = {
          [file]: lines(`${file.endsWith(".py") ? "#" : "//"} GET /api/ledger/statements`, line),
          "config/ledger.json": lines("{", '  "base": "api/ledger/"', "}"),
        };
        const f = fact(
          `i-${file}`,
          "call",
          "rest",
          "/api/ledger/statements",
          [file, 2, "statements"],
          [["config/ledger.json", 2, "api/ledger/"]],
        );
        expect([file, await one(files, f)]).toEqual([file, "kept"]);
      }
    });

    it("keeps a WebForms .asmx web method", async () => {
      const files = {
        "src/Northwind.Forms/Ledger/Upload.asmx": lines(
          '<%@ WebService Language="C#" CodeBehind="Upload.asmx.cs" Class="Northwind.Forms.Ledger.Upload" %>',
        ),
        "src/Northwind.Forms/Ledger/Upload.asmx.cs": lines(
          "public class Upload : WebService", // 1
          "{", // 2
          "    [WebMethod]", // 3
          "    public void UploadStatement()", // 4
          "    {", // 5
          "    }", // 6
          "}", // 7
        ),
      };
      const f = fact(
        "a1",
        "entry",
        "rest",
        "/Ledger/Upload.asmx/UploadStatement",
        ["src/Northwind.Forms/Ledger/Upload.asmx", 1, "Upload.asmx"],
        [["src/Northwind.Forms/Ledger/Upload.asmx.cs", 4, "UploadStatement"]],
        "POST",
      );
      expect(await one(files, f)).toBe("kept");
    });

    it("keeps a call through a generated (NSwag) client, the group and its prefix as parts", async () => {
      const files = {
        "src/Web/ClientApp/src/ledger/statement.service.ts": lines(
          "export class StatementService {", // 1
          "  list() {", // 2
          "    return this.statementsClient.list(true);", // 3
          "  }", // 4
          "}", // 5
        ),
        "src/Web/Endpoints/Statements.cs": lines(
          "public class Statements : EndpointGroupBase", // 1
          "{", // 2
          "    public override void Map(WebApplication app)", // 3
          "    {", // 4
          "        app.MapGroup(this).MapGet(List);", // 5
          "    }", // 6
          "}", // 7
        ),
        "src/Web/Infrastructure/WebApplicationExtensions.cs": lines(
          '        return app.MapGroup($"/api/{groupName}").WithGroupName(groupName);',
        ),
      };
      const f = fact(
        "n1",
        "call",
        "rest",
        "/api/Statements/list",
        ["src/Web/ClientApp/src/ledger/statement.service.ts", 3, "list"],
        [
          ["src/Web/Endpoints/Statements.cs", 1, "Statements"],
          ["src/Web/Endpoints/Statements.cs", 5, "MapGet(List)"],
          ["src/Web/Infrastructure/WebApplicationExtensions.cs", 1, "/api/{groupName}"],
        ],
      );
      expect(await one(files, f)).toBe("kept");
    });

    it("keeps a DRF @action named by its method, the router's prefix a part", async () => {
      const files = {
        "ledger/views.py": lines(
          "class StatementViewSet(viewsets.ModelViewSet):", // 1
          "    @action(detail=False, methods=['get'])", // 2
          "    def recent_postings(self, request):", // 3
          "        return Response([])", // 4
        ),
        "ledger/urls.py": lines(
          "router = DefaultRouter()",
          "router.register(r'statements', StatementViewSet)",
        ),
      };
      const f = fact(
        "d1",
        "entry",
        "rest",
        "/statements/recent_postings",
        ["ledger/views.py", 2, "@action"],
        [["ledger/urls.py", 2, "statements"]],
      );
      expect(await one(files, f)).toBe("kept");
    });

    it("keeps a Spring mapping by a constant, with only the class's prefix a part", async () => {
      const J = "src/main/java/forge/ledger/StatementResource.java";
      const files = {
        [J]: lines(
          "@RestController", // 1
          '@RequestMapping("/api")', // 2
          "class StatementResource {", // 3
          "  @GetMapping(Paths.STATEMENTS)", // 4
          "  public List<Statement> statements() { return null; }", // 5
          "}", // 6
        ),
      };
      expect(
        await one(
          files,
          fact(
            "c1",
            "entry",
            "rest",
            "/api/statements",
            [J, 4, "Paths.STATEMENTS"],
            [[J, 2, "/api"]],
          ),
        ),
      ).toBe("kept");
    });

    it("still refuses a method under a commented-out mapping, in Spring, ASP.NET and FastAPI", async () => {
      const J = "src/main/java/forge/portal/BalanceResource.java";
      const java = {
        [J]: lines(
          "@RestController", // 1
          '@RequestMapping("/api")', // 2
          "class BalanceResource {", // 3
          '  // @GetMapping("/balances")', // 4
          "  public List<Balance> balances() { return null; }", // 5
          '  @GetMapping("/statements")', // 6
          "  public List<Statement> statements() { return null; }", // 7
          "}", // 8
        ),
      };
      expect(
        await one(
          java,
          fact("x1", "entry", "rest", "/api/balances", [J, 5, "balances"], [[J, 2, "/api"]]),
        ),
      ).toBe("claim-in-comment");
      // the live mapping beside it is kept
      expect(
        await one(
          java,
          fact("x2", "entry", "rest", "/api/statements", [J, 7, "statements"], [[J, 2, "/api"]]),
        ),
      ).toBe("kept");
      const C = "src/Northwind.Api/Controllers/LedgerController.cs";
      const cs = {
        [C]: lines(
          '[Route("api/[controller]")]', // 1
          "public class LedgerController : ControllerBase", // 2
          "{", // 3
          "", // 4
          '    // [HttpGet("balances")]', // 5
          "    public IActionResult Balances() => Ok();", // 6
          "}", // 7
        ),
      };
      // `[controller]` alone is no conventional route: the action is named by its attribute
      expect(
        await one(
          cs,
          fact(
            "x3",
            "entry",
            "rest",
            "/api/Ledger/balances",
            [C, 6, "Balances"],
            [[C, 1, "api/[controller]"]],
          ),
        ),
      ).toBe("claim-in-comment");
      const files = {
        "app/api/balances.py": lines(
          "router = APIRouter()", // 1
          "", // 2
          "", // 3
          '# @router.get("/balances")', // 4
          "def balances():", // 5
          "    return []", // 6
        ),
        "app/main.py": lines('app.include_router(router, prefix="/api/v1")'),
      };
      expect(
        await one(
          files,
          fact(
            "x4",
            "entry",
            "rest",
            "/api/v1/balances",
            ["app/api/balances.py", 5, "balances"],
            [["app/main.py", 1, "/api/v1"]],
          ),
        ),
      ).toBe("claim-in-comment");
      // and a call: a commented-out client line above a live helper of the same name
      const T = "src/portal/ledger.ts";
      const ts = {
        [T]: lines(
          "export const ledger = {", // 1
          "  // balances: () => http.get(`${base}/balances`),", // 2
          "  balances: () => cache.read(),", // 3
          "};", // 4
        ),
        "src/portal/config.ts": lines('export const base = "/api";'),
      };
      expect(
        await one(
          ts,
          fact(
            "x5",
            "call",
            "rest",
            "/api/balances",
            [T, 3, "balances"],
            [["src/portal/config.ts", 1, "/api"]],
          ),
        ),
      ).toBe("claim-in-comment");
    });
  });

  // Fourth review of ADR 0196: comment markers per file type, a block comment's inner lines, and a
  // conventional action named on the cite's own lines. Shapes from the bench, in Forge names.
  describe("comments as each language writes them (fourth review of ADR 0196)", () => {
    type P = [file: string, line: number, value: string];
    const fact = (
      id: string,
      kind: "entry" | "call",
      path: string,
      cite: P,
      parts: P[] = [],
      method = "GET",
    ) =>
      ({
        ...base,
        kind,
        id,
        ...(kind === "entry" ? { entryType: "rest" } : { callType: "rest" }),
        method,
        path,
        cite: {
          file: cite[0],
          line: cite[1],
          value: cite[2],
          ...(parts.length
            ? { with: parts.map(([file, line, value]) => ({ file, line, value })) }
            : {}),
        },
      }) as Fact;
    const one = async (files: Record<string, string>, f: Fact) => {
      const r = await verifyFacts({ source: memorySource(files), facts: [f] });
      return r.rejected[0]?.code ?? "kept";
    };
    const lines = (...ls: string[]) => [...ls, ""].join("\n");

    it("reads each file type's own markers", () => {
      const cases: [string, string, boolean][] = [
        // hash-comment files: `#` only, so Python's keyword-only `*` and `*args` are code
        ["    *, session: SessionDep, item_in: ItemCreate", "app/api/routes/items.py", false],
        ["    *args, **kwargs", "app/util.py", false],
        ["    # @router.get('/balances')", "app/api/routes/items.py", true],
        ['#[app.get("/balances")]', "app/main.py", true],
        ["#!/usr/bin/env python", "bin/run.py", false],
        ["# a comment", "config/app.yaml", true],
        ["// not a comment here", "config/app.yaml", false],
        ["  # x", "Dockerfile", true],
        ["# x", "Dockerfile.dev", true],
        ["# x", "Makefile", true],
        ["# x", "requirements-dev.txt", true],
        ["; ledger url", "conf/ledger.ini", true],
        ["! ledger url", "src/main/resources/application.properties", true],
        // C-family: `//`, `/*`, a doc block's `*`; `#` never
        ["  #base = '/api/ledger';", "src/portal/ledger.js", false],
        ["  #count = 0;", "src/portal/ledger.ts", false],
        ["#region Balances", "src/Ledger/BalanceController.cs", false],
        ["#include <ledger.h>", "src/ledger.c", false],
        ["#![allow(dead_code)]", "src/main.rs", false],
        ['  #[get("/x")]', "src/main.rs", false],
        ["  // @GetMapping('/x')", "src/A.java", true],
        ["   * @param id the ledger", "src/A.java", true],
        ["   */", "src/A.ts", true],
        ["  *entries() {", "src/ledger.ts", false],
        ["  *[Symbol.iterator]() {", "src/ledger.js", false],
        ["/* a */ router.get('/x')", "src/a.js", false],
        ["/* a */ // b", "src/a.js", true],
        ["  // x", "Jenkinsfile", true],
        // PHP: C's and `#`, not PHP 8's `#[`, in every PHP extension
        ["# a comment", "src/A.php", true],
        ["#[Route('/x')]", "src/A.php", false],
        ["#[Route('/x')]", "includes/routes.inc", false],
        ["#[Route('/x')]", "ledger.module", false],
        ["#[Route('/x')]", "legacy/a.php5", false],
        ["#[Route('/x')]", "tests/a.phpt", false],
        ["#[Route('/x')]", "views/a.phtml", false],
        // SQL and XML
        ["-- a comment", "db/V1__init.sql", true],
        ["--a comment", "db/V1__init.sql", true],
        ["# not a comment", "db/V1__init.sql", false],
        ["  <!-- <url>/x</url> -->", "pom.xml", true],
        ["  <!-- a --> <route path='/x'/>", "web/routes.xml", false],
        ["  // x", "pom.xml", false],
        // anything else: every marker, as before
        ["# Heading", "README.md", true],
        ["// x", "main.tf", true],
        ["# x", "main.tf", true],
        ["  // fetch('/x')", "public/index.html", true],
      ];
      for (const [l, file, want] of cases)
        expect([l, file, isCommentLine(l, file)]).toEqual([l, file, want]);
    });

    it("keeps a part on Python's keyword-only `*,` line and on a JavaScript `#private` field", async () => {
      const PY = "app/api/routes/items.py";
      const py = {
        [PY]: lines(
          'router = APIRouter(prefix="/items")', // 1
          "", // 2
          '@router.post("/")', // 3
          "def create_item(", // 4
          "    *, session: SessionDep, item_in: ItemCreate", // 5
          ") -> Any:", // 6
        ),
      };
      expect(
        await one(
          py,
          fact(
            "p1",
            "entry",
            "/items",
            [PY, 3, "/"],
            [
              [PY, 1, "/items"],
              [PY, 5, "item_in: ItemCreate"],
            ],
            "POST",
          ),
        ),
      ).toBe("kept");
      const JS = "src/portal/ledger.js";
      const js = {
        [JS]: lines(
          "export class LedgerClient {", // 1
          '  #base = "/api/ledger";', // 2
          "  balances() {", // 3
          "    return fetch(`${this.#base}/balances`);", // 4
          "  }", // 5
          "}", // 6
        ),
      };
      expect(
        await one(
          js,
          fact(
            "j1",
            "call",
            "/api/ledger/balances",
            [JS, 4, "/balances"],
            [[JS, 2, "/api/ledger"]],
          ),
        ),
      ).toBe("kept");
      // a part only a real `#` comment names is still refused
      const commented = {
        [PY]: py[PY].replace(
          'router = APIRouter(prefix="/items")',
          '# router = APIRouter(prefix="/items")',
        ),
      };
      expect(
        await one(
          commented,
          fact("p2", "entry", "/items", [PY, 3, "/"], [[PY, 1, "/items"]], "POST"),
        ),
      ).toBe("claim-in-comment");
    });

    it("reads the lines inside a block comment as comment, in a C-family file", async () => {
      const J = "src/main/java/forge/portal/BalanceResource.java";
      const java = {
        [J]: lines(
          "@RestController", // 1
          '@RequestMapping("/api")', // 2
          "class BalanceResource {", // 3
          "  /* removed:", // 4
          '     @GetMapping("/balances") */', // 5
          "  public List<Balance> balances() { return null; }", // 6
          '  @GetMapping("/statements")', // 7
          "  public List<Statement> statements() { return null; }", // 8
          "}", // 9
        ),
      };
      expect(
        await one(java, fact("b1", "entry", "/api/balances", [J, 6, "balances"], [[J, 2, "/api"]])),
      ).toBe("claim-in-comment");
      expect(await one(java, fact("b2", "entry", "/balances", [J, 5, "/balances"]))).toBe(
        "claim-in-comment",
      );
      // the live mapping below the block, and code after a block's close, are kept
      expect(
        await one(
          java,
          fact("b3", "entry", "/api/statements", [J, 8, "statements"], [[J, 2, "/api"]]),
        ),
      ).toBe("kept");
      const closed = {
        [J]: java[J].replace('     @GetMapping("/balances") */', '  */ @GetMapping("/balances")'),
      };
      expect(
        await one(
          closed,
          fact("b4", "entry", "/api/balances", [J, 6, "balances"], [[J, 2, "/api"]]),
        ),
      ).toBe("kept");
      // a `/*` after a line comment's `//`, or inside a path string, opens no block
      const T = "src/portal/routes.ts";
      const ts = {
        [T]: lines(
          "// matches /* and more", // 1
          'router.get("/api/*", proxy);', // 2
          'router.get("/statements", list);', // 3
          'app.use("/v1", router);', // 4
        ),
      };
      expect(
        await one(
          ts,
          fact("t1", "entry", "/v1/statements", [T, 3, "/statements"], [[T, 4, "/v1"]]),
        ),
      ).toBe("kept");
    });

    it('keeps a DRF @action with no url_path and a method\'s own [Route("[action]")], whatever a comment beside them says', async () => {
      const files = {
        "ledger/views.py": lines(
          "class StatementViewSet(viewsets.ModelViewSet):", // 1
          "    # GET /statements/recent_postings/", // 2
          "    @action(detail=False, methods=['get'])", // 3
          "    def recent_postings(self, request):", // 4
          "        return Response([])", // 5
        ),
        "ledger/urls.py": lines(
          "router = DefaultRouter()",
          "router.register(r'statements', StatementViewSet)",
        ),
      };
      expect(
        await one(
          files,
          fact(
            "d1",
            "entry",
            "/statements/recent_postings",
            ["ledger/views.py", 3, "@action"],
            [["ledger/urls.py", 2, "statements"]],
          ),
        ),
      ).toBe("kept");
      // with url_path the path is that, not the method's name: a comment's path alone names nothing
      const pathed = {
        ...files,
        "ledger/views.py": files["ledger/views.py"].replace(
          "@action(detail=False, methods=['get'])",
          "@action(detail=False, methods=['get'], url_path='recent')",
        ),
      };
      expect(
        await one(
          pathed,
          fact(
            "d2",
            "entry",
            "/statements/recent_postings",
            ["ledger/views.py", 3, "@action"],
            [["ledger/urls.py", 2, "statements"]],
          ),
        ),
      ).toBe("claim-in-comment");
      const C = "src/Northwind.Api/Controllers/LedgerController.cs";
      const cs = {
        [C]: lines(
          '[Route("api/[controller]")]', // 1
          "public class LedgerController : ControllerBase", // 2
          "{", // 3
          "    // GET api/ledger/balances", // 4
          '    [HttpGet, Route("[action]")]', // 5
          "    public IActionResult Balances() => Ok();", // 6
          "}", // 7
        ),
      };
      expect(
        await one(
          cs,
          fact(
            "a1",
            "entry",
            "/api/Ledger/Balances",
            [C, 5, "[action]"],
            [[C, 1, "api/[controller]"]],
          ),
        ),
      ).toBe("kept");
      // a commented-out `[action]` is no conventional route
      const off = {
        [C]: cs[C].replace(
          '    [HttpGet, Route("[action]")]',
          '    // [HttpGet, Route("[action]")] GET api/ledger/balances',
        ),
      };
      expect(
        await one(
          off,
          fact(
            "a2",
            "entry",
            "/api/Ledger/Balances",
            [C, 6, "Balances"],
            [[C, 1, "api/[controller]"]],
          ),
        ),
      ).toBe("claim-in-comment");
    });
  });
});

describe("a route the file's place gives (held-out run)", () => {
  const base = {
    repo: "web",
    commit: "0123abc",
    verified: "none" as const,
    by: "assistant" as const,
    conf: "declared" as const,
  };
  const entry = (id: string, path: string, file: string, line = 1) => ({
    ...base,
    kind: "entry" as const,
    id,
    entryType: "rest" as const,
    method: "GET",
    path,
    cite: { file, line, value: path },
  });
  const src = memorySource({
    "src/Web/Pages/Basket/Checkout.cshtml": "@page\n@model CheckoutModel\n",
    "src/Web/Pages/Index.cshtml": "@page\n@model IndexModel\n",
    "src/Web/Areas/Identity/Pages/Account/Login.cshtml": "@page\n@model LoginModel\n",
    "src/Web/Pages/Admin/Edit.cshtml": '@page "{id:int}"\n',
    "WebForms/Web.config": "<configuration />\n",
    "WebForms/Catalog/Create.aspx":
      '<%@ Page Title="Create" Language="C#" CodeBehind="Create.aspx.cs" Inherits="Forge.Create" %>\n',
    "web/src/app/discussions/[discussionId]/page.tsx": "export default function Page() {}\n",
    "web/src/pages/teams/index.tsx": "export default function Teams() {}\n",
    "public/_redirects": "/* /index.html 200\n",
  });
  it("takes a Razor Page, a WebForms page and a Next.js page at the path their file gives", async () => {
    const r = await verifyFacts({
      source: src,
      facts: [
        entry("rp", "/Basket/Checkout", "src/Web/Pages/Basket/Checkout.cshtml"),
        entry("rp-index", "/", "src/Web/Pages/Index.cshtml"),
        entry(
          "rp-area",
          "/Identity/Account/Login",
          "src/Web/Areas/Identity/Pages/Account/Login.cshtml",
        ),
        entry("rp-template", "/Admin/Edit/{id}", "src/Web/Pages/Admin/Edit.cshtml"),
        entry("wf", "/Catalog/Create.aspx", "WebForms/Catalog/Create.aspx"),
        entry(
          "next-app",
          "/discussions/{discussionId}",
          "web/src/app/discussions/[discussionId]/page.tsx",
        ),
        entry("next-pages", "/teams", "web/src/pages/teams/index.tsx"),
        entry("redirect", "/*", "public/_redirects"),
      ],
    });
    expect(r.rejected.map((x) => [x.fact.id, x.code, x.message])).toEqual([]);
  });
  it("rejects a path the file doesn't give", async () => {
    const r = await verifyFacts({
      source: src,
      facts: [
        entry("rp-wrong", "/Basket/Index", "src/Web/Pages/Basket/Checkout.cshtml"),
        entry("wf-wrong", "/Catalog/Edit.aspx", "WebForms/Catalog/Create.aspx"),
      ],
    });
    expect(r.rejected.map((x) => x.code)).toEqual(["claim-not-on-line", "claim-not-on-line"]);
  });
});

describe("coverage: reported, never trusted (ADR 0124)", () => {
  it("doesn't count tests, build wrappers, package docs or message bundles as source", async () => {
    const { isSourceFile } = await import("../src/index.js");
    for (const p of [
      "src/test/java/org/x/OwnerControllerTests.java",
      "src/main/java/org/x/package-info.java",
      "mvnw.cmd",
      "gradlew",
      "src/main/resources/messages/messages_de.properties",
      "web/app/owner.spec.ts",
      "tests/test_items.py",
      "Services/Ordering.FunctionalTests/OrderingApiTests.cs",
    ])
      expect(isSourceFile(p), p).toBe(false);
    for (const p of [
      "src/main/java/org/x/OwnerController.java",
      "src/main/resources/application.properties",
      "app/api/routes/items.py",
    ])
      expect(isSourceFile(p), p).toBe(true);
  });

  it("accepts a config key by the last part of its YAML path or flag", async () => {
    const src = memorySource({
      "k8s/app.yaml": "        httpGet:\n          path: /actuator/health\n",
      "ci.sh": "kubectl wait --for=condition=ready --timeout=60s pod\n",
    });
    const base = {
      repo: "x",
      commit: "0123abc",
      settingKind: "config" as const,
      verified: "none" as const,
      by: "assistant" as const,
      conf: "declared" as const,
    };
    const r = await verifyFacts({
      source: src,
      facts: [
        {
          kind: "config",
          id: "k1",
          ...base,
          key: "livenessProbe.httpGet.path",
          value: "/actuator/health",
          cite: { file: "k8s/app.yaml", line: 2, value: "path" },
        },
        {
          kind: "config",
          id: "k2",
          ...base,
          key: "kubectl wait --timeout",
          value: "60s",
          cite: { file: "ci.sh", line: 1, value: "timeout" },
        },
      ],
    });
    expect(r.rejected).toEqual([]);
  });

  it("counts cited and routed files as read, the rest unknown; excludes generated code and secrets", async () => {
    const facts = load("forge-ledger.facts.jsonl");
    const r = await verifyFacts({
      facts,
      source: dirSource(repo),
      commit: "0123abc",
      routed: ["src/main/java/forge/ledger/SettlementListener.java"],
      exclude: ["generated/**"],
    });
    expect(r.coverage.read).toEqual(
      [
        "k8s/ledger-api.yaml",
        "src/main/java/forge/ledger/AccountController.java",
        "src/main/java/forge/ledger/AccountRepository.java",
        "src/main/java/forge/ledger/EntryController.java",
        "src/main/java/forge/ledger/EntryRepository.java",
        "src/main/java/forge/ledger/EntryRequest.java",
        "src/main/java/forge/ledger/FxClient.java",
        "src/main/java/forge/ledger/Notifier.java",
        "src/main/java/forge/ledger/SettlementListener.java",
        "src/main/resources/application.yml",
        "src/main/resources/db/migration/V2__create_entry.sql",
      ].sort(),
    );
    expect(r.coverage.unknown).toEqual([]);
    expect(r.coverage.excluded).toEqual(["generated/client.ts"]);
    expect(r.coverage.ratio).toBe(1);
    const partial = await verifyFacts({
      facts: facts.filter((f) => f.cite.file !== "k8s/ledger-api.yaml"),
      source: dirSource(repo),
      commit: "0123abc",
    });
    expect(partial.coverage.unknown).toContain("k8s/ledger-api.yaml");
    expect(partial.coverage.unknown).toContain("generated/client.ts");
    expect(partial.coverage.ratio).toBeLessThan(1);
  });

  it("is deterministic: the same input gives the same report", async () => {
    const facts = load("forge-ledger.facts.jsonl");
    const a = await verifyFacts({ facts, source: dirSource(repo), commit: "0123abc" });
    const b = await verifyFacts({
      facts: [...facts].reverse(),
      source: dirSource(repo),
      commit: "0123abc",
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
