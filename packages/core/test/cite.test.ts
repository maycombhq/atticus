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
    // a template written without its leading slash (ASP.NET, Flask blueprints)
    expect(lineNamesRoute('[HttpPost("uploadimage")]', "/uploadimage")).toBe(true);
    expect(lineNamesRoute('[Route("api/v1/[controller]")]', "/api/v1/catalog")).toBe(false);
    expect(lineNamesRoute('[Route("api/v1/orders")]', "/api/v1/orders")).toBe(true);
    expect(lineNamesRoute('var x = "myuploadimage";', "/uploadimage")).toBe(false);
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

describe("a path put together from several lines (ADR 0124 addendum A4)", () => {
  it("names what the held-out reads wrote (A4, batch 2)", async () => {
    const { partsNamePath } = await import("../src/index.js");
    // a value ending in punctuation, followed by an identifier
    expect(
      lineNamesWord("    return ArticleInResponse(article=x)", "return ArticleInResponse("),
    ).toBe(true);
    expect(lineNamesWord('placeholder="Write a comment..."', "Write a comment...")).toBe(true);
    expect(lineNamesWord("entries.push(x)", "entry")).toBe(false);
    // a front end's root route
    expect(lineNamesRoute("  { path: '', component: HomeComponent },", "/")).toBe(true);
    expect(lineNamesRoute("      { index: true, element: <Landing /> },", "/")).toBe(true);
    // a slugified route: the action's name, written with hyphens in the URL
    expect(
      partsNamePath(
        [
          "public class ManageController : Controller {",
          "  public async Task<IActionResult> MyAccount() {",
          "options.Conventions.Add(new RouteTokenTransformerConvention(new SlugifyParameterTransformer()));",
        ],
        "/manage/my-account",
      ),
    ).toBe(true);
  });
  it("names / for the default action of a conventional route, and nothing else", async () => {
    const { partsNamePath } = await import("../src/index.js");
    const home = ["public class HomeController : Controller {", "  public IActionResult Index() {"];
    expect(partsNamePath([...home, "app.MapDefaultControllerRoute();"], "/")).toBe(true);
    expect(
      partsNamePath(
        [...home, 'routes.MapRoute("Default", "{controller=Home}/{action=Index}/{id?}");'],
        "/",
      ),
    ).toBe(true);
    // another controller's Index isn't the default; no default route, no root
    expect(
      partsNamePath(
        [
          "public class CatalogController {",
          "  public IActionResult Index() {",
          "app.MapDefaultControllerRoute();",
        ],
        "/",
      ),
    ).toBe(false);
    expect(partsNamePath(home, "/")).toBe(false);
    // ASP.NET MVC 5's defaults object
    expect(
      partsNamePath(
        [
          "public class CatalogController : Controller {",
          "  public ActionResult Index() {",
          '    defaults: new { controller = "Catalog", action = "Index", id = UrlParameter.Optional }',
        ],
        "/",
      ),
    ).toBe(true);
  });
  it("is named when every plain part is written on one of its lines", async () => {
    const { partsNamePath } = await import("../src/index.js");
    // Angular: base URL in the environment file, the entity in the service
    expect(
      partsNamePath(
        [
          "  REST_API_URL: 'http://localhost:9966/petclinic/api/'",
          "    this.entityUrl = environment.REST_API_URL + 'owners';",
        ],
        "/petclinic/api/owners/{id}",
      ),
    ).toBe(true);
    // minimal API: group prefix on one line, the route on another
    expect(
      partsNamePath(
        ['var api = app.MapGroup("api/orders");', '  api.MapGet("{orderId:int}", GetOrder);'],
        "/api/orders/{orderId}",
      ),
    ).toBe(true);
    // gRPC: package, service and method from the proto
    expect(
      partsNamePath(
        [
          "package BasketApi;",
          "service Basket {",
          "  rpc GetBasket(GetBasketRequest) returns (CustomerBasketResponse);",
        ],
        "BasketApi.Basket/GetBasket",
      ),
    ).toBe(true);
    // MVC conventional route: controller and action names
    expect(
      partsNamePath(
        [
          "public class AccountController : Controller",
          "  public IActionResult Login(string returnUrl)",
        ],
        "/account/login",
      ),
    ).toBe(true);
    // a part written nowhere fails
    expect(
      partsNamePath(
        ["this.entityUrl = environment.REST_API_URL + 'owners';"],
        "/petclinic/api/owners",
      ),
    ).toBe(false);
  });
});

describe("secret-looking keys: the key's last part ends in a secret word", () => {
  it("redacts ClientSecret and db.password, not TokenUrl or AccessTokenLifetime", () => {
    expect(redactSecrets('    "ClientSecret": "s3cr3t",')).toBe('    "ClientSecret": <redacted>');
    expect(redactSecrets("  password: hunter2")).toBe("  password: <redacted>");
    expect(redactSecrets('    "TokenUrl": "https://id.example/connect/token",')).toBe(
      '    "TokenUrl": "https://id.example/connect/token",',
    );
    expect(redactSecrets("    AccessTokenLifetime = 7200,")).toBe(
      "    AccessTokenLifetime = 7200,",
    );
  });
});
