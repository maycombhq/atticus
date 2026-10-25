import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFacts, type Fact } from "@maycombhq/core";
import { dirSource, entriesNoFlowFollows, memorySource, verifyFacts } from "../src/index.js";

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
