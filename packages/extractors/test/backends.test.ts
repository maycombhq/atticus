import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CatalogRecord } from "@maycombhq/core";
import { fsRepo, memoryRepo, scanRepo, type Extractor, type RepoHandle } from "@maycombhq/sdk";
import {
  BACKEND_EXTRACTORS,
  dotnetExtractor,
  goExtractor,
  nodeExtractor,
  pythonExtractor,
} from "../src/backends/index.js";
import { SourceFile, type SourceLang } from "../src/backends/shared.js";
import { componentExtractor, frontendExtractor } from "../src/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SHA = "0123456789abcdef0123456789abcdef01234567";

async function scan(
  repo: RepoHandle,
  extractors: Extractor[],
  info: { component?: string; repoType?: string } = {},
) {
  const s = await scanRepo({
    repo,
    extractors,
    scannedAt: "2026-10-18T08:00:00Z",
    repoInfo: info,
  });
  expect(s.rejected).toEqual([]);
  expect(s.runs.filter((x) => x.status === "failed")).toEqual([]);
  expect(s.warnings).toEqual([]);
  return s.records;
}

const fixture = (lang: string, name: string) => fsRepo(name, join(FIXTURES, lang, name), SHA);
const mem = (files: Record<string, string>) => memoryRepo("svc", SHA, files);

type Rec = Record<string, unknown>;
const ev = (r: CatalogRecord) =>
  r.evidence.map((e) => `${e.path}:${e.line ?? ""}:${e.side ?? ""}`).join(",");

/** One line per record with every field the backend extractors are responsible for. */
function golden(recs: CatalogRecord[]): string[] {
  return recs
    .map((r) => {
      const x = r as unknown as Rec;
      if (r.kind === "Endpoint")
        return `Endpoint ${x.component} ${x.method} ${x.pathOrTopic} [${x.normalizedPath}] @${ev(r)}`;
      if (r.kind === "Unresolved")
        return `Unresolved ${x.owner} ${x.unresolvedKind} ${x.raw} @${ev(r)}`;
      if (r.kind === "Component")
        return `Component ${r.id} system=${x.system} repo=${x.repo} type=${x.type} @${ev(r)}`;
      return `${r.kind} ${r.id}`;
    })
    .sort();
}

/** Ids follow the shared helpers: endpoints `<component>.<method>.<hash>`, loose ends `<owner>.<kind>.<hash>`. */
function checkShapes(recs: CatalogRecord[], component: string, extractor: string) {
  for (const r of recs) {
    const x = r as unknown as Rec;
    if (r.kind === "Endpoint") {
      expect(r.id).toMatch(
        new RegExp(`^${component}\\.${String(x.method).toLowerCase()}\\.[0-9a-f]{10}$`),
      );
      expect(x).toMatchObject({ endpointType: "rest", confidence: "verified", schemaRefs: [] });
    }
    if (r.kind === "Unresolved") {
      expect(r.id).toMatch(new RegExp(`^${component}\\.${x.unresolvedKind}\\.[0-9a-f]{10}$`));
      expect(r.confidence).toBe("inferred");
    }
    for (const e of r.evidence) {
      expect(e.extractor).toBe(
        `${extractor}@${BACKEND_EXTRACTORS.find((b) => b.id === extractor)!.version}`,
      );
      expect(e.repo).toBeDefined();
      expect(e.commit).toBe(SHA);
    }
  }
}

describe("source files from syntax trees", () => {
  it("skips comments and reads strings in each language", async () => {
    const ext: Record<SourceLang, string> = { python: "py", csharp: "cs", go: "go", js: "js" };
    const strs = async (src: string, lang: SourceLang) =>
      (await SourceFile.parse(`f.${ext[lang]}`, src, lang)).toks
        .filter((t) => t.t === "str")
        .map((t) => `${t.line}:${t.interp ? "i" : ""}${t.v}`);
    expect(
      await strs(
        `# "no"\nx = f"{BASE}/a/{id!r}/{{lit}}"  # "no"\ny = r'\\d+' + """\nmulti "q"\n"""\nz = rb"raw"`,
        "python",
      ),
    ).toEqual(["2:i${BASE}/a/${id}/{lit}", "3:\\d+", '3:\nmulti "q"\n', "6:raw"]);
    expect(
      await strs(
        `// "no"\n/* "no" */ var a = $"{x:N2}/b"; var b = @"c:\\""d";\n  #region "no"\nvar c = """\n  raw "x"\n  """; var d = '"';`,
        "csharp",
      ),
    ).toEqual(["2:i${x}/b", '2:c:\\"d', '4:\n  raw "x"\n  ']);
    expect(await strs('// `no`\nx := `a\nb` + "c\\"d" // "no"\nr := \'"\'', "go")).toEqual([
      "2:a\nb",
      '3:c"d',
    ]);
    expect(
      await strs(
        "const a = `x${b + `y${c}`}/z`; // 'no'\nconst re = /'no'/g; const d = 4 / 2 / 1; e('ok');",
        "js",
      ),
    ).toEqual(["1:ix${b + `y${c}`}/z", "2:ok"]);
  });

  it("reads calls from the tree: not in comments or strings, and not declarations", async () => {
    const calls = async (path: string, src: string, lang: SourceLang) =>
      (await SourceFile.parse(path, src, lang)).calls.map(
        (c) =>
          `${c.line}:${c.isNew ? "new " : ""}${c.decorator ? "@" : ""}${c.callee}` +
          `${c.generics.length ? `<${c.generics.join(",")}>` : ""}(${c.args.length})` +
          `${c.chained ? ` on ${c.chained.name}` : ""}`,
      );
    expect(
      await calls(
        "a.ts",
        `// fetch("/in-a-comment")
const s = 'fetch("/in-a-string")';
class Api {
  get(id: string): Promise<Book> { return this.http.get<Book>(\`/books/\${id}\`); }
}
for (const x of xs) await client.send(Message<string, string>(a, b), done);
new pg.Pool({ connectionString }).connect();`,
        "js",
      ),
    ).toEqual([
      "4:this.http.get<Book>(1)",
      "6:client.send(2)",
      "6:Message<string,string>(2)",
      "7:new pg.Pool(1)",
      "7:connect(0) on Pool",
    ]);
    expect(
      await calls(
        "a.py",
        `@app.get("/x", tags=["a"])
def read():  # requests.get("/no")
    raise HTTPException(status_code=404)`,
        "python",
      ),
    ).toEqual(["1:@app.get(2)", "3:HTTPException(1)"]);
    expect(
      await calls(
        "A.cs",
        `[Route("api")] public class A : ControllerBase {
  public A(HttpClient http) : base(http) { }
  public Task<string> Get() => _http?.GetStringAsync(url: "/x");
}`,
        "csharp",
      ),
    ).toEqual(["1:Route(1)", "3:_http.GetStringAsync(1)"]);
    expect(
      await calls(
        "a.go",
        `package a
func (s *S) Name() { for rows.Next() { go s.run(ctx) } }`,
        "go",
      ),
    ).toEqual(["2:rows.Next(0)", "2:s.run(1)"]);
  });

  it("reads imports from the tree", async () => {
    const imports = async (path: string, src: string, lang: SourceLang) =>
      (await SourceFile.parse(path, src, lang)).imports.map((i) =>
        `${i.spec} ${i.names.map((n) => `${n.local}=${n.name}`).join(",")}`.trim(),
      );
    expect(
      await imports(
        "a.ts",
        `import web, { Router as R } from "express";
import * as k from "kafkajs";
const { a, b: c } = require("./m");
// import x from "not-an-import";`,
        "js",
      ),
    ).toEqual(["express web=default,R=Router", "kafkajs k=*", "./m"]);
    expect(
      await imports(
        "a.py",
        "import a.b, c as d\nfrom .rates import router as r, x\n# import nope",
        "python",
      ),
    ).toEqual(["a.b a=*", "c d=*", ".rates r=router,x=x"]);
    expect(await imports("A.cs", "using Confluent.Kafka;\n// using Nope;", "csharp")).toEqual([
      "Confluent.Kafka",
    ]);
    expect(
      await imports("a.go", 'package a\nimport (\n\tk "github.com/segmentio/kafka-go"\n)', "go"),
    ).toEqual(["github.com/segmentio/kafka-go k=*"]);
  });
});

// ------------------------------------------------------------------ .NET

describe("dotnet", () => {
  it("reads controllers, minimal APIs, typed and Refit clients, Kafka and the connection string", async () => {
    const recs = await scan(fixture("dotnet", "forge-statements"), [dotnetExtractor], {
      component: "statements-api",
      repoType: "dotnet",
    });
    const C = "Forge.Statements/Controllers/StatementsController.cs";
    const L = "Forge.Statements/LedgerClient.cs";
    const P = "Forge.Statements/Program.cs";
    expect(golden(recs)).toEqual(
      [
        `Component statements-api system=statements-api repo=forge-statements type=dotnet @Forge.Statements/Forge.Statements.csproj::`,
        `Endpoint statements-api GET /api/statements/{accountId} [/api/statements/{}] @${C}:13:callee`,
        `Endpoint statements-api POST /api/statements/{accountId:guid}/regenerate [/api/statements/{}/regenerate] @${C}:17:callee`,
        `Endpoint statements-api GET /internal/ping [/internal/ping] @${C}:23:callee`,
        `Endpoint statements-api GET /health [/health] @${P}:14:callee`,
        `Endpoint statements-api POST /api/exports/{statementId} [/api/exports/{}] @${P}:17:callee`,
        `Unresolved statements-api http-call GET http://ledger-api.forge.internal/accounts/{accountId}/balance @${L}:16:caller`,
        `Unresolved statements-api http-call POST http://ledger-api.forge.internal/accounts/{accountId}/holds @${L}:20:caller`,
        `Unresolved statements-api http-call POST http://audit-svc.forge.internal/audit/events @${L}:27:caller`,
        `Unresolved statements-api event-publish statements.generated @${L}:34:caller`,
        `Unresolved statements-api db-connection postgresql://statements-db.forge.internal:5432/statements @Forge.Statements/appsettings.json:7:caller`,
      ].sort(),
    );
    checkShapes(recs, "statements-api", "dotnet");
    expect(recs.find((r) => r.kind === "Component")!.evidence[0]!.source).toBe("config");
    expect(
      recs
        .filter((r) => r.kind === "Unresolved")
        .map((r) => r.evidence[0]!.source)
        .sort(),
    ).toEqual(["code", "code", "code", "code", "config"]);
  });

  it("fills the component only where the generic component extractor finds nothing", async () => {
    const recs = await scan(
      fixture("dotnet", "forge-statements"),
      [componentExtractor, dotnetExtractor],
      { component: "statements-api" },
    );
    expect(recs.filter((r) => r.kind === "Component").map(ev)).toEqual([
      "Forge.Statements/Forge.Statements.csproj::",
    ]);
    // A root project file is the component extractor's; dotnet stays quiet.
    const root = mem({ "Forge.Fx.csproj": "<Project/>", "Program.cs": "var x = 1;" });
    const both = await scan(root, [componentExtractor, dotnetExtractor]);
    expect(both.filter((r) => r.kind === "Component").map((r) => ev(r))).toEqual([
      "Forge.Fx.csproj::",
    ]);
    expect(
      both.find((r) => r.kind === "Component")!.evidence[0]!.extractor?.startsWith("component@"),
    ).toBe(true);
    // Gateways, topic configs and infrastructure repos are never components.
    const gw = await scan(fixture("dotnet", "forge-statements"), [dotnetExtractor], {
      repoType: "gateway",
    });
    expect(gw.some((x) => x.kind === "Component")).toBe(false);
  });

  it("handles route tokens, method routes, nested groups, Service Bus, RabbitMQ and SQL Server", async () => {
    const repo = mem({
      "Api/Api.csproj":
        '<Project><ItemGroup><PackageReference Include="Microsoft.Data.SqlClient" /></ItemGroup></Project>',
      "Api/appsettings.json":
        '{ "ConnectionStrings": { "Main": "Server=tcp:holds-sql.forge.internal,1433;Initial Catalog=holds;User ID=x;Password=y" } }',
      "Api/HoldsController.cs": `using Microsoft.AspNetCore.Mvc;
using Azure.Messaging.ServiceBus;
[Route("v2/[controller]/[action]")]
public class HoldsController : Controller
{
    [HttpGet]
    public IActionResult List() => Ok();
    [Route("by-account/{id}")]
    [HttpDelete]
    public IActionResult Release(string id) => Ok();
    public IActionResult NotAnEndpoint() => Ok();
    public async Task Notify(ServiceBusClient bus, IDistributedCache cache) {
        var sender = bus.CreateSender("holds-released");
        var processor = bus.CreateProcessor("holds-requested", "holds-api");
        await cache.GetAsync("http-cache-key");
        channel.BasicPublish(exchange: "", routingKey: "holds.audit", body: b);
        channel.BasicConsume(queue: "holds.commands", autoAck: true, consumer: c);
    }
}`,
      "Api/Routes.cs": `var app = WebApplication.Create();
var v1 = app.MapGroup("/v1");
var holds = v1.MapGroup("holds");
holds.MapPut("{id}", Handler);
holds.MapMethods("/{id}/extend", new[] { "PATCH" }, Handler);
var api = RestService.For<IFxApi>("http://fx-rates.forge.internal");
public interface IFxApi { [Get("/v1/rates/{pair}")] Task<Rate> Get(string pair); }`,
    });
    expect(golden(await scan(repo, [dotnetExtractor], { component: "holds-api" }))).toEqual(
      [
        "Component holds-api system=holds-api repo=svc type=unknown @Api/Api.csproj::",
        "Endpoint holds-api GET /v2/holds/list [/v2/holds/list] @Api/HoldsController.cs:6:callee",
        "Endpoint holds-api DELETE /v2/holds/release/by-account/{id} [/v2/holds/release/by-account/{}] @Api/HoldsController.cs:9:callee",
        "Endpoint holds-api PUT /v1/holds/{id} [/v1/holds/{}] @Api/Routes.cs:4:callee",
        "Endpoint holds-api PATCH /v1/holds/{id}/extend [/v1/holds/{}/extend] @Api/Routes.cs:5:callee",
        "Unresolved holds-api http-call GET http://fx-rates.forge.internal/v1/rates/{pair} @Api/Routes.cs:7:caller",
        "Unresolved holds-api event-publish holds-released @Api/HoldsController.cs:13:caller",
        "Unresolved holds-api event-subscribe holds-requested @Api/HoldsController.cs:14:callee",
        "Unresolved holds-api event-publish holds.audit @Api/HoldsController.cs:16:caller",
        "Unresolved holds-api event-subscribe holds.commands @Api/HoldsController.cs:17:callee",
        "Unresolved holds-api db-connection sqlserver://holds-sql.forge.internal:1433/holds @Api/appsettings.json:1:caller",
      ].sort(),
    );
  });
});

// ------------------------------------------------------------------ Python

describe("python", () => {
  it("reads FastAPI routers across files, httpx calls with .env and defaults, Kafka and the engine URL", async () => {
    const recs = await scan(fixture("python", "forge-fx-rates"), [pythonExtractor], {
      component: "fx-rates",
    });
    const R = "fx_rates/rates.py";
    expect(golden(recs)).toEqual(
      [
        "Endpoint fx-rates GET /health [/health] @fx_rates/main.py:9:callee",
        `Endpoint fx-rates GET /v1/rates/{pair} [/v1/rates/{}] @${R}:19:callee`,
        `Endpoint fx-rates POST /v1/rates/{pair}/quotes [/v1/rates/{}/quotes] @${R}:26:callee`,
        `Unresolved fx-rates db-connection postgresql://fx-db.forge.internal:5432/fx @${R}:13:caller`,
        `Unresolved fx-rates event-subscribe transfers.completed @${R}:16:callee`,
        `Unresolved fx-rates http-call GET http://ledger-api.forge.internal/accounts/{pair}/balance @${R}:22:caller`,
        `Unresolved fx-rates http-call POST http://audit-svc.forge.internal/audit/events @${R}:28:caller`,
        `Unresolved fx-rates http-call POST \${NOTIFY_URL}/notify @${R}:29:caller`,
        `Unresolved fx-rates event-publish fx.quote.created @${R}:30:caller`,
      ].sort(),
    );
    checkShapes(recs, "fx-rates", "python");
    // pyproject.toml at the root: the component extractor names the component, python doesn't.
    const both = await scan(
      fixture("python", "forge-fx-rates"),
      [componentExtractor, pythonExtractor],
      { component: "fx-rates" },
    );
    expect(both.filter((r) => r.kind === "Component").map(ev)).toEqual(["pyproject.toml::"]);
  });

  it("reads Flask blueprints, requests sessions and request()", async () => {
    const repo = mem({
      "requirements.txt": "flask\nrequests\n",
      "app.py": `import requests
from flask import Blueprint, Flask

app = Flask(__name__)
bp = Blueprint("rates", __name__, url_prefix="/rates")


@bp.route("/<pair>", methods=["GET", "POST"])
def rate(pair):
    s = requests.Session()
    s.get("http://ledger-api.forge.internal/accounts/1")
    return requests.request("DELETE", "http://holds.forge.internal/holds/" + hold_id)


@app.route("/ping")
def ping():
    cache = {}
    cache.get("http://not-a-call")
    return "pong"


app.register_blueprint(bp, url_prefix="/v2/rates")
`,
    });
    expect(golden(await scan(repo, [pythonExtractor], { component: "rates" }))).toEqual(
      [
        "Endpoint rates GET /v2/rates/<pair> [/v2/rates/{}] @app.py:8:callee",
        "Endpoint rates POST /v2/rates/<pair> [/v2/rates/{}] @app.py:8:callee",
        "Endpoint rates GET /ping [/ping] @app.py:15:callee",
        "Unresolved rates http-call GET http://ledger-api.forge.internal/accounts/1 @app.py:11:caller",
        "Unresolved rates http-call DELETE http://holds.forge.internal/holds/{hold_id} @app.py:12:caller",
      ].sort(),
    );
  });

  it("reads api_route, clients kept on self, str.format URLs and constants imported from another module", async () => {
    const repo = mem({
      "requirements.txt": "fastapi\nhttpx\n",
      "app/api.py": `import httpx
from fastapi import APIRouter, FastAPI

from app.settings import BASE_URL

app = FastAPI()
r = APIRouter()


@r.api_route("/x", methods=["GET", "POST"])
def x(): ...


@app.websocket("/ws")
async def ws(): ...


class Ledger:
    def __init__(self):
        self.client = httpx.Client(base_url=BASE_URL)

    def get(self, account_id):
        return self.client.get("/accounts/{}".format(account_id))


app.include_router(r)
`,
      "app/settings.py":
        'import os\nBASE_URL = os.environ.get("LEDGER_URL", "http://ledger-api.forge.internal")\n',
    });
    expect(golden(await scan(repo, [pythonExtractor], { component: "c" }))).toEqual(
      [
        "Endpoint c GET /x [/x] @app/api.py:10:callee",
        "Endpoint c POST /x [/x] @app/api.py:10:callee",
        "Unresolved c http-call GET http://ledger-api.forge.internal/accounts/{account_id} @app/api.py:23:caller",
      ].sort(),
    );
  });

  it("reads Django urls with include() and a setup.py-only component", async () => {
    const repo = mem({
      "setup.py": "from setuptools import setup\nsetup(name='forge-site')\n",
      "forge_site/urls.py": `from django.urls import include, path
from . import views

urlpatterns = [
    path("api/", include("rates.urls")),
    path("health/", views.health),
    # path("old/", views.old),
]
`,
      "rates/urls.py": `from django.urls import path, re_path
from . import views

urlpatterns = [
    path("rates/<int:pk>/", views.detail, name="detail"),
    re_path(r"^legacy/(?P<pk>[0-9]+)/$", views.legacy),
]
`,
      "rates/tests/urls.py": 'urlpatterns = [path("only-in-tests/", v)]\n',
    });
    expect(golden(await scan(repo, [componentExtractor, pythonExtractor]))).toEqual(
      [
        "Component svc system=svc repo=svc type=unknown @setup.py::",
        "Endpoint svc ANY /health [/health] @forge_site/urls.py:6:callee",
        "Endpoint svc ANY /api/rates/<int:pk> [/api/rates/{}] @rates/urls.py:5:callee",
        "Endpoint svc ANY /api/legacy/{pk} [/api/legacy/{}] @rates/urls.py:6:callee",
      ].sort(),
    );
  });
});

// ------------------------------------------------------------------ Go

describe("go", () => {
  it("reads gin groups and router parameters, http calls, kafka-go and skips tests", async () => {
    const recs = await scan(fixture("go", "forge-notify"), [goExtractor], {
      component: "notify-svc",
    });
    expect(golden(recs)).toEqual(
      [
        "Endpoint notify-svc GET /healthz [/healthz] @main.go:13:callee",
        "Endpoint notify-svc POST /v1/notifications [/v1/notifications] @main.go:17:callee",
        "Endpoint notify-svc GET /v1/notifications/:id [/v1/notifications/{}] @main.go:18:callee",
        "Endpoint notify-svc DELETE /v1/admin/cache/:key [/v1/admin/cache/{}] @main.go:25:callee",
        "Unresolved notify-svc http-call GET http://ledger-api.forge.internal/accounts/{id}/balance @client.go:22:caller",
        "Unresolved notify-svc http-call POST http://audit-svc.forge.internal/audit/events @client.go:26:caller",
        "Unresolved notify-svc event-publish notify.sent @client.go:35:caller",
        "Unresolved notify-svc event-subscribe transfers.completed @client.go:42:callee",
      ].sort(),
    );
    checkShapes(recs, "notify-svc", "go");
  });

  it("reads chi routes and mounts, Go 1.22 patterns, sarama and sql.Open", async () => {
    const repo = mem({
      "go.mod": "module example.com/forge/rates\n",
      "cmd/server/main.go": `package main

import (
	"database/sql"
	"net/http"

	"github.com/IBM/sarama"
	"github.com/go-chi/chi/v5"
)

func main() {
	r := chi.NewRouter()
	r.Get("/ping", ping)
	r.Route("/rates", func(r chi.Router) {
		r.Get("/{pair}", getRate)
		r.With(auth).Post("/", createRate)
	})
	r.Mount("/admin", adminRouter())
	mux := http.NewServeMux()
	mux.HandleFunc("GET /accounts/{id}", h)
	mux.HandleFunc("/legacy/", h)
	http.HandleFunc("/metrics", h)
	db, _ := sql.Open("postgres", "postgres://app:pw@rates-db.forge.internal:5432/rates?sslmode=disable")
	msg := &sarama.ProducerMessage{Topic: "rates.changed", Value: v}
	cache.Get("http://not-a-call")
}

func adminRouter() chi.Router {
	r := chi.NewRouter()
	r.Delete("/cache", clearCache)
	return r
}
`,
    });
    expect(golden(await scan(repo, [goExtractor], { component: "rates" }))).toEqual(
      [
        "Endpoint rates GET /ping [/ping] @cmd/server/main.go:13:callee",
        "Endpoint rates GET /rates/{pair} [/rates/{}] @cmd/server/main.go:15:callee",
        "Endpoint rates POST /rates [/rates] @cmd/server/main.go:16:callee",
        "Endpoint rates DELETE /admin/cache [/admin/cache] @cmd/server/main.go:30:callee",
        "Endpoint rates GET /accounts/{id} [/accounts/{}] @cmd/server/main.go:20:callee",
        "Endpoint rates ANY /legacy [/legacy] @cmd/server/main.go:21:callee",
        "Endpoint rates ANY /metrics [/metrics] @cmd/server/main.go:22:callee",
        "Unresolved rates db-connection postgres://rates-db.forge.internal:5432/rates @cmd/server/main.go:23:caller",
        "Unresolved rates event-publish rates.changed @cmd/server/main.go:24:caller",
      ].sort(),
    );
  });
});

// ------------------------------------------------------------------ Node

describe("node", () => {
  it("reads Express routers across files, resolved calls, kafkajs and skips tests", async () => {
    const recs = await scan(fixture("node", "forge-onboarding"), [nodeExtractor], {
      component: "onboarding-api",
    });
    const A = "src/routes/accounts.js";
    expect(golden(recs)).toEqual(
      [
        "Endpoint onboarding-api GET /health [/health] @src/app.js:7:callee",
        `Endpoint onboarding-api GET /api/accounts/:id [/api/accounts/{}] @${A}:12:callee`,
        `Endpoint onboarding-api POST /api/accounts [/api/accounts] @${A}:17:callee`,
        `Unresolved onboarding-api http-call GET http://ledger-api.forge.internal/accounts/{id}/balance @${A}:13:caller`,
        `Unresolved onboarding-api http-call POST http://kyc-svc.forge.internal/checks @${A}:18:caller`,
        `Unresolved onboarding-api event-publish accounts.opened @${A}:21:caller`,
      ].sort(),
    );
    checkShapes(recs, "onboarding-api", "node");
  });

  it("leaves literal fetch and axios calls to the frontend extractor, so each call is reported once", async () => {
    const recs = await scan(
      fixture("node", "forge-onboarding"),
      [componentExtractor, frontendExtractor, nodeExtractor],
      { component: "onboarding-api" },
    );
    const calls = recs
      .filter((r) => (r as unknown as Rec).unresolvedKind === "http-call")
      .map((r) => `${(r as unknown as Rec).raw} @${ev(r)} ${r.evidence[0]!.extractor}`)
      .sort();
    expect(calls).toEqual([
      "GET http://ledger-api.forge.internal/accounts/{id}/balance @src/routes/accounts.js:13:caller node@0.1.0",
      "POST http://audit-svc.forge.internal/audit/events @src/routes/accounts.js:19:caller frontend@1.1.0",
      "POST http://kyc-svc.forge.internal/checks @src/routes/accounts.js:18:caller node@0.1.0",
    ]);
    expect(recs.filter((r) => r.kind === "Component").map(ev)).toEqual(["package.json::"]);
  });

  it("reads NestJS controllers with the global prefix and event patterns", async () => {
    const repo = mem({
      "package.json":
        '{ "dependencies": { "@nestjs/core": "^10.0.0", "@nestjs/common": "^10.0.0" } }',
      "src/main.ts": `import { NestFactory } from "@nestjs/core";
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix("api");
  await app.listen(3000);
}`,
      "src/fx.controller.ts": `import { Controller, Get, Post } from "@nestjs/common";

@Controller("fx")
export class FxController {
  constructor(private readonly http: HttpService) {}

  @Get(":pair")
  rate(@Param("pair") pair: string) {}

  @Post()
  quote() {}

  // @Delete(":pair")
  @EventPattern("fx.rate.changed")
  changed() {}
}

@Controller({ path: "health" })
export class HealthController {
  @Get()
  ok() {}
}`,
    });
    expect(golden(await scan(repo, [nodeExtractor], { component: "fx-api" }))).toEqual(
      [
        "Endpoint fx-api GET /api/fx/:pair [/api/fx/{}] @src/fx.controller.ts:7:callee",
        "Endpoint fx-api POST /api/fx [/api/fx] @src/fx.controller.ts:10:callee",
        "Endpoint fx-api GET /api/health [/api/health] @src/fx.controller.ts:20:callee",
        "Unresolved fx-api event-subscribe fx.rate.changed @src/fx.controller.ts:14:callee",
      ].sort(),
    );
  });

  it("reads Fastify routes, route() and register() prefixes, and axios instances", async () => {
    const repo = mem({
      "package.json": '{ "dependencies": { "fastify": "^4.0.0", "axios": "^1.0.0" } }',
      "server.mjs": `import Fastify from "fastify";
import axios from "axios";

const fastify = Fastify({ logger: true });
const ledger = axios.create({ baseURL: process.env.LEDGER_URL });

fastify.get("/ping", async () => "pong");
fastify.route({ method: ["GET", "HEAD"], url: "/rates/:pair", handler: rate });
fastify.register(ratesRoutes, { prefix: "/v1" });

async function ratesRoutes(app) {
  app.post("/quotes", async (req) => ledger.get(\`/accounts/\${req.body.account}\`));
}
`,
    });
    expect(golden(await scan(repo, [nodeExtractor], { component: "rates" }))).toEqual(
      [
        "Endpoint rates GET /ping [/ping] @server.mjs:7:callee",
        "Endpoint rates GET /rates/:pair [/rates/{}] @server.mjs:8:callee",
        "Endpoint rates HEAD /rates/:pair [/rates/{}] @server.mjs:8:callee",
        "Endpoint rates POST /v1/quotes [/v1/quotes] @server.mjs:12:callee",
        "Unresolved rates http-call GET ${LEDGER_URL}/accounts/{account} @server.mjs:12:caller",
      ].sort(),
    );
  });

  it("reads route() chains, renamed imports, koa-router prefixes, hapi route lists and typed axios calls", async () => {
    const repo = mem({
      "package.json":
        '{ "dependencies": { "express": "4", "@koa/router": "12", "@hapi/hapi": "21", "axios": "1" } }',
      "src/a.ts": `import web, { Router } from "express";
import axios from "axios";
import KoaRouter from "@koa/router";
const r = Router();
r.route("/books/:id").get(h).put(h);
const app = web();
app.use("/v1", r);
app.get("env");
const k = new KoaRouter({ prefix: "/k" });
k.get("/ping", h);
const x = await axios.get<Book>("/api/books");
const y = await axios({ method: "post", url: process.env.HOOK_URL + "/hooks" });
`,
      "src/hapi.js": `const Hapi = require("@hapi/hapi");
const server = Hapi.server({ port: 3000 });
server.route([{ method: "GET", path: "/a/{id}", handler }, { method: ["POST", "PUT"], path: "/b", handler }]);
`,
    });
    expect(
      golden(await scan(repo, [nodeExtractor, frontendExtractor], { component: "c" })),
    ).toEqual(
      [
        "Endpoint c GET /v1/books/:id [/v1/books/{}] @src/a.ts:5:callee",
        "Endpoint c PUT /v1/books/:id [/v1/books/{}] @src/a.ts:5:callee",
        "Endpoint c GET /k/ping [/k/ping] @src/a.ts:10:callee",
        "Endpoint c GET /a/{id} [/a/{}] @src/hapi.js:3:callee",
        "Endpoint c POST /b [/b] @src/hapi.js:3:callee",
        "Endpoint c PUT /b [/b] @src/hapi.js:3:callee",
        // axios.get<Book>(...) has type arguments, which the frontend extractor doesn't read.
        "Unresolved c http-call GET /api/books @src/a.ts:11:caller",
        "Unresolved c http-call POST ${HOOK_URL}/hooks @src/a.ts:12:caller",
      ].sort(),
    );
  });

  it("does nothing for a frontend package", async () => {
    const repo = mem({
      "package.json": '{ "dependencies": { "react": "^18.0.0" } }',
      "src/api.ts": 'app.get("/x", h); fetch(`${process.env.API}/balance`);',
    });
    expect(await scan(repo, [nodeExtractor])).toEqual([]);
  });
});

describe("backend extractors", () => {
  it("are versioned with stable ids", () => {
    expect(BACKEND_EXTRACTORS.map((x) => `${x.id}@${x.version}`)).toEqual([
      "dotnet@0.1.1",
      "go@0.1.0",
      "node@0.1.0",
      "python@0.1.0",
    ]);
  });

  it("emit nothing on a Java repo", async () => {
    const repo = mem({
      "pom.xml": "<project/>",
      "src/main/java/A.java": 'class A { void a() { http.Get("/x"); } }',
    });
    expect(await scan(repo, [...BACKEND_EXTRACTORS])).toEqual([]);
  });

  it("emit nothing on the Forge repos (Java, a React UI, gateway, topics, infrastructure)", async () => {
    const FORGE = join(FIXTURES, "../../../../fixtures/forge/repos");
    for (const id of [
      "forge-portal-ui",
      "forge-portal-bff",
      "forge-ledger",
      "forge-reports-job",
      "forge-gateway",
      "forge-events",
      "forge-infra",
    ])
      expect(await scan(fsRepo(id, join(FORGE, id), SHA), [...BACKEND_EXTRACTORS]), id).toEqual([]);
  });

  it("leave unknown config keys and environment variables visible instead of guessing", async () => {
    const dotnet = mem({
      "Fx.cs": `public class FxClient(HttpClient http, IConfiguration config)
{
    public Task<string> Rates() => http.GetStringAsync(config["Services:Fx:BaseUrl"] + "/rates");
}`,
    });
    const go = mem({
      "main.go": `package main

import "net/http"

func rates() { http.Get(os.Getenv("FX_URL") + "/rates") }
`,
    });
    expect(golden(await scan(dotnet, [dotnetExtractor], { component: "a" }))).toEqual([
      "Unresolved a http-call GET ${Services:Fx:BaseUrl}/rates @Fx.cs:3:caller",
    ]);
    expect(golden(await scan(go, [goExtractor], { component: "b" }))).toEqual([
      "Unresolved b http-call GET ${FX_URL}/rates @main.go:5:caller",
    ]);
  });
});

describe("frontend calls from the tree", () => {
  it("reports fetch, axios and http calls in code only, in TS, JSX and Vue files", async () => {
    const repo = mem({
      "src/api.ts": `// fetch("/in-a-comment")
const help = 'call fetch("/in-a-string")';
export const balance = (id: string) =>
  fetch(\`/api/balance/\${id}\`, {
    method: "POST",
  });
export const rates = () => axios.get("/api/rates");`,
      "src/App.jsx": `export const App = () => <button onClick={() => this.http.delete("/api/session")}>fetch("/no")</button>;`,
      "src/Cart.vue": `<template><p>fetch("/not-script")</p></template>
<script setup lang="ts">
const cart = await fetch("/api/cart");
</script>`,
    });
    expect(golden(await scan(repo, [frontendExtractor]))).toEqual([
      "Unresolved svc http-call DELETE /api/session @src/App.jsx:1:caller",
      "Unresolved svc http-call GET /api/cart @src/Cart.vue:3:caller",
      "Unresolved svc http-call GET /api/rates @src/api.ts:7:caller",
      "Unresolved svc http-call POST /api/balance/{id} @src/api.ts:4:caller",
    ]);
  });
});

describe("ASP.NET Core action names", () => {
  it("drops the Async suffix from [action], as ASP.NET Core does by default", async () => {
    const repo = mem({
      "Api/StatementsController.cs": `using Microsoft.AspNetCore.Mvc;
[ApiController]
[Route("api/[controller]/[action]")]
public class StatementsController : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> GetLatestAsync() => Ok();
    [HttpPost]
    public IActionResult Close() => Ok();
}`,
    });
    const paths = golden(await scan(repo, [dotnetExtractor], { component: "a" }))
      .filter((l) => l.startsWith("Endpoint"))
      .map((l) => l.split(" ").slice(2, 4).join(" "));
    expect(paths).toEqual(["GET /api/statements/getlatest", "POST /api/statements/close"]);
  });
});
