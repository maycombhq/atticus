import type { ApiCase, ContractCase, DataCase, EventCase, RepoTests, TestModel } from "../model.js";
import type { GeneratedFile } from "../header.js";
import { camel, pascal, quote, uniqueNames } from "../words.js";
import type { RenderContext, TestGenerator } from "./types.js";

/**
 * JUnit 5 + RestAssured skeletons for Java services: API tests against ATTICUS_BASE_URL,
 * consumer contract tests against a stub of the provider (`atticus stub <provider>`, at
 * ATTICUS_STUB_URL), provider contract tests against the service, data tests through JDBC
 * (ATTICUS_DB_URL) and event tests the team connects to its event harness. Tests that need
 * an environment the pipeline doesn't give are skipped with the reason, never failed.
 */

const CODE = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/;

const textBlock = (v: unknown) => {
  const json = JSON.stringify(v, null, 2).replace(/\\/g, "\\\\").replace(/"""/g, '\\"""');
  return `"""\n${json
    .split("\n")
    .map((l) => `        ${l}`)
    .join("\n")}\n        """`;
};

function statusMatcher(status: string): string {
  if (/^\d{3}$/.test(status)) return `.statusCode(${status})`;
  const d = /^([1-5])XX$/i.exec(status)?.[1];
  return d
    ? `.statusCode(allOf(greaterThanOrEqualTo(${d}00), lessThan(${Number(d) + 1}00)))`
    : ".statusCode(greaterThanOrEqualTo(400))";
}

function bodyChecks(fields: string[], body: unknown): string[] {
  const out: string[] = [];
  if (body && typeof body === "object" && !Array.isArray(body))
    for (const [k, v] of Object.entries(body as Record<string, unknown>))
      if (typeof v === "string" && CODE.test(v))
        out.push(`.body("${quote(k)}", equalTo("${quote(v)}"))`);
  for (const f of fields)
    if (!out.some((o) => o.startsWith(`.body("${f}"`)))
      out.push(`.body("$", hasKey("${quote(f)}"))`);
  return out;
}

function authLine(c: ApiCase): string[] {
  if (c.request.auth === "none") return [];
  if (c.request.auth === "no-scope")
    return [
      `.auth().oauth2(env("ATTICUS_TOKEN_WITHOUT_${c.request.scope!.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}"))`,
    ];
  switch (c.request.authType) {
    case "basic":
      return [`.auth().preemptive().basic(env("ATTICUS_USER"), env("ATTICUS_PASSWORD"))`];
    case "apiKey":
    case "api-key":
      return [`.header(env("ATTICUS_API_KEY_HEADER", "X-API-Key"), env("ATTICUS_API_KEY"))`];
    case "mtls":
    case "mutualTLS":
      return [
        `// mTLS: the client certificate comes from the test environment (RestAssured keyStore).`,
      ];
    default:
      return [`.auth().oauth2(env("ATTICUS_TOKEN"))`];
  }
}

const header = (pkg: string) => [
  `package ${pkg};`,
  "",
  "import static io.restassured.RestAssured.given;",
  "import static org.hamcrest.Matchers.*;",
  "",
  "import io.restassured.http.ContentType;",
  "import org.junit.jupiter.api.Assumptions;",
  "import org.junit.jupiter.api.DisplayName;",
  "import org.junit.jupiter.api.Test;",
  "",
];

const ENV = [
  "  private static String env(String name) {",
  '    return env(name, "");',
  "  }",
  "",
  "  private static String env(String name, String fallback) {",
  "    String v = System.getenv(name);",
  "    return v == null || v.isEmpty() ? fallback : v;",
  "  }",
];

function apiMethod(c: ApiCase, name: string, baseVar: string): string[] {
  const lines = [`  @Test`, `  @DisplayName("${quote(c.name)}")`, `  void ${name}() {`];
  if (c.request.auth === "no-scope") {
    const v = `ATTICUS_TOKEN_WITHOUT_${c.request.scope!.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
    lines.push(
      `    Assumptions.assumeFalse(env("${v}").isEmpty(), "Set ${v} to a token without ${quote(c.request.scope!)}.");`,
    );
  }
  if (c.kind === "error" || c.why.includes("needs data")) lines.push(`    // ${c.why}`);
  const hasBody = c.request.body !== undefined;
  const dataVar = c.data && (c.kind === "happy" || c.kind === "error") ? c.data.name : "body";
  if (hasBody) lines.push(`    String ${dataVar} = ${textBlock(c.request.body)};`);
  lines.push(`    given()`, `        .baseUri(${baseVar})`);
  for (const a of authLine(c)) lines.push(`        ${a}`);
  for (const [k, v] of Object.entries(c.request.pathParams))
    lines.push(`        .pathParam("${quote(k)}", ${JSON.stringify(v)})`);
  for (const [k, v] of Object.entries(c.request.query))
    lines.push(`        .queryParam("${quote(k)}", ${JSON.stringify(v)})`);
  if (hasBody) lines.push(`        .contentType(ContentType.JSON)`, `        .body(${dataVar})`);
  lines.push(
    `        .when()`,
    `        .${c.method.toLowerCase()}("${quote(c.path)}")`,
    `        .then()`,
  );
  const checks = [
    statusMatcher(c.expect.status),
    ...(c.kind === "happy" || c.kind === "error" ? bodyChecks(c.expect.fields, c.expect.body) : []),
  ];
  checks.forEach((ch, i) => lines.push(`        ${ch}${i === checks.length - 1 ? ";" : ""}`));
  lines.push("  }");
  return lines;
}

function apiClass(
  m: TestModel,
  repo: RepoTests,
  pkg: string,
  cls: string,
  cases: ApiCase[],
): string {
  const names = uniqueNames(cases.map((c) => camel(c.name)));
  const body = cases.flatMap((c, i) => ["", ...apiMethod(c, names[i]!, "BASE_URL")]);
  return [
    ...header(pkg),
    `/** API tests for story ${m.story.id} (change ${m.change}) on ${repo.component ?? repo.repo}. Base URL: ATTICUS_BASE_URL. */`,
    `class ${cls} {`,
    `  private static final String BASE_URL = env("ATTICUS_BASE_URL", "http://localhost:8080");`,
    ...body,
    "",
    ...ENV,
    "}",
    "",
  ].join("\n");
}

function contractMethod(c: ContractCase, name: string): string[] {
  const lines = [`  @Test`, `  @DisplayName("${quote(c.name)}")`, `  void ${name}() {`];
  for (const ch of c.checks) lines.push(`    // ${ch}`);
  for (const g of c.gaps) lines.push(`    // Gap: ${g}`);
  if (c.topic) {
    lines.push(
      `    Assumptions.abort("Connect the event test harness: ${quote(c.role === "consumer" ? `deliver a ${c.topic} message to ${c.consumer}` : `capture what ${c.provider} publishes to ${c.topic}`)}.");`,
      "  }",
    );
    return lines;
  }
  const base = c.role === "consumer" ? "STUB_URL" : "BASE_URL";
  const hasBody = c.request.example !== undefined;
  if (hasBody) lines.push(`    String body = ${textBlock(c.request.example)};`);
  lines.push(`    given()`, `        .baseUri(${base})`);
  if (c.role === "provider") lines.push(`        .auth().oauth2(env("ATTICUS_TOKEN"))`);
  for (const m of (c.path ?? "").matchAll(/\{([^}]+)\}/g))
    lines.push(`        .pathParam("${quote(m[1]!)}", 1)`);
  if (hasBody) lines.push(`        .contentType(ContentType.JSON)`, `        .body(body)`);
  lines.push(
    `        .when()`,
    `        .${(c.method ?? "get").toLowerCase()}("${quote(c.path ?? "/")}")`,
    `        .then()`,
  );
  const checks = [
    c.response.status ? statusMatcher(c.response.status) : ".statusCode(lessThan(400))",
    ...c.response.fields.map((f) => `.body("$", hasKey("${quote(f.split(/[.[]/)[0]!)}"))`),
  ];
  checks.forEach((ch, i) => lines.push(`        ${ch}${i === checks.length - 1 ? ";" : ""}`));
  lines.push("  }");
  return lines;
}

function contractClass(m: TestModel, pkg: string, cls: string, cases: ContractCase[]): string {
  const names = uniqueNames(cases.map((c) => camel(c.name)));
  return [
    ...header(pkg),
    `/**`,
    ` * Contract tests for story ${m.story.id} (change ${m.change}). Consumer tests run against a stub`,
    ` * of the provider (atticus stub <provider>, at ATTICUS_STUB_URL); provider tests against the`,
    ` * service at ATTICUS_BASE_URL.`,
    ` */`,
    `class ${cls} {`,
    `  private static final String BASE_URL = env("ATTICUS_BASE_URL", "http://localhost:8080");`,
    `  private static final String STUB_URL = env("ATTICUS_STUB_URL", "http://127.0.0.1:4010");`,
    ...cases.flatMap((c, i) => ["", ...contractMethod(c, names[i]!)]),
    "",
    ...ENV,
    "}",
    "",
  ].join("\n");
}

function dataClass(m: TestModel, pkg: string, cls: string, cases: DataCase[]): string {
  const names = uniqueNames(cases.map((c) => camel(c.name)));
  const body = cases.flatMap((c, i) => {
    const lines = [
      "",
      `  @Test`,
      `  @DisplayName("${quote(c.name)}")`,
      `  void ${names[i]}() throws Exception {`,
    ];
    for (const ch of c.checks) lines.push(`    // ${ch}`);
    if (c.kind === "migration") {
      lines.push(
        `    Assumptions.abort("Run ${quote(c.migration ?? "the migration")} on a copy of ${quote(c.store)} in the pipeline, then run this class.");`,
        "  }",
      );
      return lines;
    }
    lines.push(`    try (Connection db = connect()) {`);
    if (c.kind === "table") {
      lines.push(
        `      assertTrue(exists(db, "${quote(c.table)}", null), "table ${quote(c.table)} exists");`,
      );
      for (const col of c.columns ?? [])
        lines.push(
          `      assertTrue(exists(db, "${quote(c.table)}", "${quote(col.name)}"), "column ${quote(col.name)} (${quote(col.type)}) exists");`,
        );
    } else {
      lines.push(
        `      assertTrue(exists(db, "${quote(c.table)}", "${quote(c.column!)}"), "column ${quote(c.table)}.${quote(c.column!)} exists");`,
      );
      if (c.notNull)
        lines.push(
          `      assertEquals("NO", nullable(db, "${quote(c.table)}", "${quote(c.column!)}"), "${quote(c.column!)} is not null");`,
        );
    }
    lines.push("    }", "  }");
    return lines;
  });
  return [
    `package ${pkg};`,
    "",
    "import static org.junit.jupiter.api.Assertions.*;",
    "",
    "import java.sql.Connection;",
    "import java.sql.DriverManager;",
    "import java.sql.PreparedStatement;",
    "import java.sql.ResultSet;",
    "import org.junit.jupiter.api.Assumptions;",
    "import org.junit.jupiter.api.DisplayName;",
    "import org.junit.jupiter.api.Test;",
    "",
    `/** Data tests for story ${m.story.id} (change ${m.change}): run against a migrated copy of the database at ATTICUS_DB_URL. */`,
    `class ${cls} {`,
    ...body,
    "",
    "  private static Connection connect() throws Exception {",
    '    String url = System.getenv("ATTICUS_DB_URL");',
    '    Assumptions.assumeTrue(url != null && !url.isEmpty(), "Set ATTICUS_DB_URL to a migrated copy of the database.");',
    '    return DriverManager.getConnection(url, System.getenv("ATTICUS_DB_USER"), System.getenv("ATTICUS_DB_PASSWORD"));',
    "  }",
    "",
    "  private static boolean exists(Connection db, String table, String column) throws Exception {",
    "    String sql = column == null",
    '        ? "select 1 from information_schema.tables where lower(table_name) = lower(?)"',
    '        : "select 1 from information_schema.columns where lower(table_name) = lower(?) and lower(column_name) = lower(?)";',
    "    try (PreparedStatement q = db.prepareStatement(sql)) {",
    "      q.setString(1, table);",
    "      if (column != null) q.setString(2, column);",
    "      try (ResultSet r = q.executeQuery()) {",
    "        return r.next();",
    "      }",
    "    }",
    "  }",
    "",
    "  private static String nullable(Connection db, String table, String column) throws Exception {",
    '    String sql = "select is_nullable from information_schema.columns where lower(table_name) = lower(?) and lower(column_name) = lower(?)";',
    "    try (PreparedStatement q = db.prepareStatement(sql)) {",
    "      q.setString(1, table);",
    "      q.setString(2, column);",
    "      try (ResultSet r = q.executeQuery()) {",
    "        return r.next() ? r.getString(1) : null;",
    "      }",
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
}

function eventClass(m: TestModel, pkg: string, cls: string, cases: EventCase[]): string {
  const names = uniqueNames(cases.map((c) => camel(c.name)));
  return [
    `package ${pkg};`,
    "",
    "import org.junit.jupiter.api.Assumptions;",
    "import org.junit.jupiter.api.DisplayName;",
    "import org.junit.jupiter.api.Test;",
    "",
    `/** Event tests for story ${m.story.id} (change ${m.change}). Connect them to the team's event test harness. */`,
    `class ${cls} {`,
    ...cases.flatMap((c, i) => [
      "",
      `  @Test`,
      `  @DisplayName("${quote(c.name)}")`,
      `  void ${names[i]}() {`,
      ...c.checks.map((ch) => `    // ${ch}`),
      `    Assumptions.abort("Connect the event test harness for ${quote(c.topic)}.");`,
      "  }",
    ]),
    "}",
    "",
  ].join("\n");
}

export const junitGenerator: TestGenerator = {
  id: "junit5-restassured",
  version: "1.0.0",
  generic: false,
  appliesTo: (repo) => repo.language === "java",
  render(model, repo, ctx: RenderContext): GeneratedFile[] {
    const pkgName = `atticus.${model.change.replace(/[^a-z0-9]+/g, "_")}`;
    const dir = `src/test/java/atticus/${model.change.replace(/[^a-z0-9]+/g, "_")}`;
    const story = pascal(model.story.id);
    const out: GeneratedFile[] = [];
    const file = (suffix: string, content: string, cases: { id: string }[]) =>
      out.push({
        path: `${dir}/${story}${suffix}.java`,
        content,
        style: "slash",
        source: ctx.source,
        cases: cases.map((c) => c.id),
      });
    const api = repo.cases.filter((c): c is ApiCase => c.type === "api");
    const contracts = repo.cases.filter((c): c is ContractCase => c.type === "contract");
    const data = repo.cases.filter((c): c is DataCase => c.type === "data");
    const events = repo.cases.filter((c): c is EventCase => c.type === "event");
    if (api.length) file("ApiTest", apiClass(model, repo, pkgName, `${story}ApiTest`, api), api);
    if (contracts.length)
      file(
        "ContractTest",
        contractClass(model, pkgName, `${story}ContractTest`, contracts),
        contracts,
      );
    if (data.length) file("DataTest", dataClass(model, pkgName, `${story}DataTest`, data), data);
    if (events.length)
      file("EventTest", eventClass(model, pkgName, `${story}EventTest`, events), events);
    return out;
  },
};
