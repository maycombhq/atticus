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

// Review round 47: a secret anywhere on the line, not only after a key at its start. The token
// shapes are put together here so no scanner mistakes this file for one holding real keys.
describe("secrets anywhere on a line (review round 47)", () => {
  const gh = "gh" + "p_" + "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7dEf";
  const pat = "github" + "_pat_" + "11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ0123456789";
  const live = "sk" + "_live_" + "4eC39HqLyjWDarjtT1zdp7dc";
  const akia = "AK" + "IA" + "IOSFODNN7EXAMPLE";
  const jwt =
    "ey" +
    "JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const golden: [string, string][] = [
    ['const password = "hunter22";', "const password = <redacted>"],
    [
      `private static final String API_KEY = "${live}";`,
      "private static final String API_KEY = <redacted>",
    ],
    [`export const githubToken = "${gh}";`, "export const githubToken = <redacted>"],
    ['{"user":"ana","password":"hunter22"}', '{"user":"ana","password":<redacted>'],
    ['  "password":"x"', '  "password":<redacted>'],
    ['val apiKey: String = "abc123def"', "val apiKey: String = <redacted>"],
    ['os.environ["API_KEY"] = "abc123def"', 'os.environ["API_KEY"] = <redacted>'],
    [
      "url: postgres://orders:p4ssw0rd@db.forge.test:5432/orders",
      "url: postgres://orders:<redacted>@db.forge.test:5432/orders",
    ],
    ["Authorization: Bearer " + jwt, "Authorization: Bearer <redacted>"],
    [
      'headers.put("Authorization", "Bearer abcdef0123456789abcdef");',
      'headers.put("Authorization", "Bearer <redacted>");',
    ],
    [
      `git remote add origin https://${gh}@git.forge.test/x.git`,
      "git remote add origin https://<redacted>@git.forge.test/x.git",
    ],
    [`token = os.getenv("T", "${pat}")`, "token = <redacted>"],
    [`client = Stripe("${live}")`, 'client = Stripe("<redacted>")'],
    [`aws_access_key_id=${akia}`, "aws_access_key_id=<redacted>"],
    [
      `s3 = boto3.client("s3", aws_access_key_id="${akia}")`,
      's3 = boto3.client("s3", aws_access_key_id="<redacted>")',
    ],
    ["export DB_PASSWORD=hunter22", "export DB_PASSWORD=<redacted>"],
    [
      "Server=db;User Id=orders;Password=p4ss;Database=orders",
      "Server=db;User Id=orders;Password=<redacted>;Database=orders",
    ],
    ['ds.setPassword("hunter22");', "ds.setPassword(<redacted>"],
    [`const t = "${jwt}";`, 'const t = "<redacted>";'],
  ];
  // Code that only names a secret word stays as it is.
  const unchanged = [
    "if (password == null) throw new IllegalArgumentException();",
    "if (password === confirm) return;",
    "while (tokenizer.hasNext()) tokenizer.next();",
    "String hash = passwordEncoder.encode(raw);",
    "const token = await tokens.issue(user);",
    'const passwordField = "#password";',
    'String password = "";',
    'const apiKey = "${API_KEY}";',
    'password: "{{ .Values.db.password }}"',
    '@PostMapping("/token")',
    'String token = request.getHeader("Authorization");',
    'headers.set("Authorization", "Bearer " + token);',
    "Basic authentication is off for the health endpoint.",
    "url: postgres://db.forge.test:5432/orders",
    "url: postgres://${DB_USER}:${DB_PASS}@db.forge.test:5432/orders",
    'fetch("https://id.forge.test/connect/token")',
    "    AccessTokenLifetime = 7200,",
    "public String getPassword() { return password; }",
  ];
  it("redacts the value, the URL's password, the bearer token and well-known token shapes", () => {
    for (const [line, want] of golden) expect(redactSecrets(line), line).toBe(want);
  });
  it("leaves code that only names a secret word unchanged", () => {
    for (const line of unchanged) expect(redactSecrets(line), line).toBe(line);
  });
  it("a redacted quote still matches its line", () => {
    for (const [line] of golden) expect(quoteMatches(line, redactSecrets(line)), line).toBe(true);
  });
  it("says when a quote still holds a literal next to a secret word redaction couldn't place", async () => {
    const { quoteHoldsSecret } = await import("../src/index.js");
    expect(quoteHoldsSecret('creds.put(PASSWORD_KEY, "Xk9fQ2mZ7p");')).toBe(true);
    for (const line of [...unchanged, "passwordEncoder.encode(x)", 'getToken("Authorization")'])
      expect(quoteHoldsSecret(line), line).toBe(false);
  });
});

describe("a word put together from cite.with parts (ADR 0124 addendum A-derived)", () => {
  it("takes each part as a whole piece, the rest written on the cited lines", async () => {
    const { partsBuildWord } = await import("../src/index.js");
    const task = ["  task triage_emails: :environment do"];
    const key = ['  redis.get(key("conferenceCache"))'];
    expect(partsBuildWord("schedule:triage_emails", ["schedule"], task)).toBe(true);
    expect(partsBuildWord("forge_conferenceCache", ["forge"], key)).toBe(true);
    expect(partsBuildWord("${prefix}_conferenceCache", ["${prefix}_"], key)).toBe(true);
    // a part inside a longer piece, a part the claim doesn't hold, a piece written nowhere
    expect(partsBuildWord("schedulex:triage_emails", ["schedule"], task)).toBe(false);
    expect(partsBuildWord("nightly:triage_emails", ["schedule"], task)).toBe(false);
    expect(partsBuildWord("schedule:triage_all", ["schedule"], task)).toBe(false);
    expect(partsBuildWord("schedule:triage_emails", [], task)).toBe(false);
  });
});

describe("an HTTP route's piece only a commented-out mapping writes (third review of ADR 0196)", () => {
  const isComment = (l: string) => /^\s*(\/\/|#)/.test(l);
  it("finds the piece a comment writes as a path and the code only as an identifier", async () => {
    const { pathPieceOnlyInComment } = await import("../src/index.js");
    const near = ['  // @GetMapping("/balances")', "  public List<Balance> balances() {}"];
    expect(
      pathPieceOnlyInComment(near, isComment, ['@RequestMapping("/api")'], "/api/balances"),
    ).toBe("balances");
    // a part's line names it: no comment is needed for it
    expect(
      pathPieceOnlyInComment(
        near,
        isComment,
        ['@RequestMapping("/api/balances")'],
        "/api/balances",
      ),
    ).toBeUndefined();
    // the code writes it as a path too: a quote, a slash, an interpolation's brace
    for (const code of [
      '  @GetMapping("/balances")',
      '  var u = $"{baseUrl}balances";',
      "  get(`${b}balances`)",
    ])
      expect(
        pathPieceOnlyInComment(
          ["  // GET /api/balances", code],
          isComment,
          ['"/api"'],
          "/api/balances",
        ),
      ).toBeUndefined();
    // no comment in the window: identifiers name pieces as the path check always let them
    expect(
      pathPieceOnlyInComment(
        ["  public List<Balance> balances() {}"],
        isComment,
        ['"/api"'],
        "/api/balances",
      ),
    ).toBeUndefined();
    // a comment of prose that names the word, not as a path
    expect(
      pathPieceOnlyInComment(
        ["  // the balances, newest first", "  balances() {}"],
        isComment,
        ['"/api"'],
        "/api/balances",
      ),
    ).toBeUndefined();
    // the comment's own marker is no path's slash
    expect(
      pathPieceOnlyInComment(
        ["//balances()", "balances() {}"],
        isComment,
        ['"/api"'],
        "/api/balances",
      ),
    ).toBeUndefined();
  });
  it("knows a conventional route by its action token or the default route, not by [controller]", async () => {
    const { declaresConventionalRoute } = await import("../src/index.js");
    for (const t of [
      "{controller}/{action}/{id}",
      "{controller=Home}/{action=Index}/{id?}",
      'routes.MapRoute(name: "Default", url: "{controller}/{action}/{id}");',
      'app.MapControllerRoute(name: "default", pattern: "{controller=Home}/{action=Index}/{id?}");',
      "app.MapDefaultControllerRoute();",
      "api/[controller]/[action]",
    ])
      expect([t, declaresConventionalRoute([t])]).toEqual([t, true]);
    for (const t of ["api/[controller]", '[Route("api/ledger")]', "MapControllers()", "actions"])
      expect([t, declaresConventionalRoute([t])]).toEqual([t, false]);
  });
  // Fourth review: a DRF action is named by its method unless it sets url_path; a method's own
  // `[Route("[action]")]` is the action token on the cite.
  it('knows a DRF @action with no url_path, and a method\'s [Route("[action]")]', async () => {
    const { declaresConventionalRoute } = await import("../src/index.js");
    for (const t of [
      "    @action(detail=False, methods=['get'])",
      "    @action(detail=True)",
      '    [HttpGet, Route("[action]")]',
    ])
      expect([t, declaresConventionalRoute([t])]).toEqual([t, true]);
    for (const t of [
      "    @action(detail=False, url_path='recent')",
      "    @action(detail=True, url_path = 'set-password')",
      "    action(request)",
    ])
      expect([t, declaresConventionalRoute([t])]).toEqual([t, false]);
  });
  // Fifth review: a window is read joined, so an @action wrapped over lines is read whole: its
  // url_path on the next line makes it no conventional route; a url_path after its close is
  // another call's.
  it("reads a DRF @action wrapped over the window's lines", async () => {
    const { declaresConventionalRoute } = await import("../src/index.js");
    const wrapped = ["    @action(detail=True,", "            url_path='recent')"];
    expect(declaresConventionalRoute([wrapped.join("\n")])).toBe(false);
    expect(
      declaresConventionalRoute([
        "    @action(\n        detail=False,\n        methods=['get'],\n    )",
      ]),
    ).toBe(true);
    expect(
      declaresConventionalRoute(["    @action(detail=True)\n    x = path(url_path='y')"]),
    ).toBe(true);
    // a call not closed in the window: what it shows has no url_path
    expect(declaresConventionalRoute(["    @action(detail=True,"])).toBe(true);
    // a second @action in the same window: either one with no url_path is conventional
    expect(
      declaresConventionalRoute(["@action(detail=True, url_path='a')\n@action(detail=False)"]),
    ).toBe(true);
  });
  it("reads a window's comment lines by their place, not their text", async () => {
    const { pathPieceOnlyInComment } = await import("../src/index.js");
    // the second line is inside a block comment: only the place says so
    const near = ['     @GetMapping("/balances") */', "  public List<Balance> balances() {}"];
    expect(pathPieceOnlyInComment(near, (_, i) => i === 0, ['"/api"'], "/api/balances")).toBe(
      "balances",
    );
    expect(pathPieceOnlyInComment(near, () => false, ['"/api"'], "/api/balances")).toBeUndefined();
  });
});
