import { beforeAll, describe, expect, it } from "vitest";
import {
  flattenProperties,
  flattenYaml,
  parseDdl,
  parseJava,
  parseXml,
  resolvePlaceholders,
  select,
  tablesInQuery,
} from "../src/index.js";

describe("Java reader", () => {
  const src = `package forge.portal;
// a comment with @Fake("x")
import org.springframework.web.bind.annotation.*;
/* block
   @AlsoFake */
@RestController
@RequestMapping({"/api", "/v2"})
public class BalanceController extends BaseController implements Audited {
  @Autowired private LedgerClient ledger;

  @GetMapping(value = "/balance/" + "{id}", produces = MediaType.APPLICATION_JSON_VALUE)
  public Balance balance(@PathVariable("id") String id) {
    return ledger.getBalance(id);
  }

  @PostMapping(path = "/transfers")
  public void transfer() { rest.postForObject("\${audit.url}/audit/events", null, Void.class); }
}`;
  let f: Awaited<ReturnType<typeof parseJava>>;
  beforeAll(async () => {
    f = await parseJava(src);
  });

  it("skips comments and reads the package", async () => {
    expect(f.packageName).toBe("forge.portal");
    expect(f.decls.flatMap((d) => d.annotations).map((a) => a.name)).not.toContain("Fake");
  });

  it("attaches annotations to the right declarations, with lines and attributes", async () => {
    const cls = f.decls.find((d) => d.kind === "class")!;
    expect(cls).toMatchObject({
      name: "BalanceController",
      supertypes: ["BaseController", "Audited"],
    });
    expect(cls.annotations.map((a) => [a.name, a.line])).toEqual([
      ["RestController", 6],
      ["RequestMapping", 7],
    ]);
    expect(cls.annotations[1]!.attrs.value).toEqual(["/api", "/v2"]);
    const m = f.decls.find((d) => d.name === "balance")!;
    expect(m).toMatchObject({ kind: "method", line: 12 });
    expect(m.parent?.name).toBe("BalanceController");
    expect(m.annotations[0]).toMatchObject({
      name: "GetMapping",
      line: 11,
      attrs: { value: "/balance/{id}", produces: "MediaType.APPLICATION_JSON_VALUE" },
    });
    expect(f.decls.find((d) => d.kind === "field")).toMatchObject({ name: "ledger" });
  });

  it("records method calls with literal arguments and where they are", async () => {
    const c = f.calls.find((x) => x.method === "postForObject")!;
    expect(c).toMatchObject({
      receiver: "rest",
      args: ["${audit.url}/audit/events", undefined, undefined],
      line: 17,
    });
    expect(c.inMethod?.name).toBe("transfer");
  });

  it("always moves on: a stray bracket in an annotation can't stop the reader", async () => {
    // Templates, archetypes and half-edited files have these; one used to hang a whole scan.
    for (const bad of ["@A(})", "@A({)", '@A({"x"])', "@A(x = })", "@A({{)", "@A(", "@A({"]) {
      const r = await parseJava(
        `class C {\n  ${bad}\n  void m() {}\n}\n@RestController class D {}\n`,
      );
      expect(
        r.decls.map((d) => d.name),
        bad,
      ).toContain("C");
    }
    // An empty value keeps the annotation's own closing parenthesis.
    const empty = await parseJava(
      'class C {\n  @A(x = )\n  @GetMapping("/ok")\n  void m() {}\n}\n',
    );
    expect(empty.decls.find((d) => d.name === "m")!.annotations.map((a) => a.name)).toEqual([
      "A",
      "GetMapping",
    ]);
  });

  it("shows every call argument, with what isn't a literal as ${...}", async () => {
    const r = await parseJava(`class P {
  void a() { rest.postForObject(base + PAY, body, Resp.class); }
  void b() { rest.getForObject("/limits/{id}", Limit.class, id); }
}`);
    const [a, b] = r.calls.filter(
      (c) => c.method === "postForObject" || c.method === "getForObject",
    );
    expect(a!.args[0]).toBeUndefined();
    expect(a!.shown[0]).toBe("${base}${PAY}");
    expect(b!.shown[0]).toBe("/limits/{id}");
  });

  it("records imports, and reads Kotlin, which ends lines without semicolons", async () => {
    const java = await parseJava(
      "package a.b;\nimport org.springframework.web.client.RestTemplate;\nimport static x.Y.*;\nclass C {}\n",
    );
    expect(java.imports).toEqual(["org.springframework.web.client.RestTemplate", "x.Y.*"]);
    const kt = await parseJava(
      `package forge.cards
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

@RestController
class CardsController {
  @GetMapping("/cards/{id}")
  fun card(id: String) = id
}
`,
      "kotlin",
    );
    expect(kt.packageName).toBe("forge.cards");
    expect(kt.imports).toHaveLength(2);
    const cls = kt.decls.find((d) => d.name === "CardsController")!;
    expect(cls.annotations.map((a) => a.name)).toEqual(["RestController"]);
  });

  it("reads text blocks and escapes from the tree", async () => {
    const f = await parseJava(
      'class Q {\n  static final String SQL = """\n  SELECT *\n  FROM entry""";\n  static final String T = "a\\tb";\n  char c = \'"\';\n}',
    );
    expect(f.constants.map((c) => [c.name, c.value])).toEqual([
      ["SQL", "\n  SELECT *\n  FROM entry"],
      ["T", "a\tb"],
    ]);
  });
});

describe("config", () => {
  it("flattens YAML with line numbers and indexes lists", async () => {
    const m = flattenYaml(
      "ledger:\n  client:\n    read-timeout: 2000ms\nlist:\n  - a\n  - b\n",
      "a.yml",
    );
    expect(m.get("ledger.client.read-timeout")).toEqual({
      value: "2000ms",
      line: 3,
      file: "a.yml",
    });
    expect(m.get("list[1]")?.value).toBe("b");
  });

  it("reads properties and resolves placeholders loosely, keeping unknown ones", async () => {
    const p = flattenProperties(
      "# c\ngateway.url=https://gw.example\naudit.read_timeout: 5s\n",
      "a.properties",
    );
    expect(p.get("gateway.url")?.line).toBe(2);
    expect(
      resolvePlaceholders("${gateway.url}/x ${audit.readTimeout} ${nope:dflt} ${missing}", p),
    ).toBe("https://gw.example/x 5s dflt ${missing}");
  });
});

describe("XML", () => {
  it("parses elements, attributes, text and lines, and selects paths", async () => {
    const x = parseXml(
      '<?xml version="1.0"?>\n<ProxyEndpoint name="default">\n  <!-- c -->\n  <HTTPProxyConnection>\n    <BasePath>/ledger/v1</BasePath>\n  </HTTPProxyConnection>\n  <Step><Name>A &amp; B</Name></Step>\n</ProxyEndpoint>',
    );
    expect(x?.attrs.name).toBe("default");
    expect(select(x, "ProxyEndpoint/HTTPProxyConnection/BasePath")[0]).toMatchObject({
      text: "/ledger/v1",
      line: 5,
    });
    expect(select(x, "//Step/Name")[0]!.text).toBe("A & B");
  });
});

describe("SQL", () => {
  it("reads tables, columns, keys and indexes with lines", async () => {
    const d = parseDdl(`-- schema
CREATE TABLE IF NOT EXISTS public."entry" (
  id BIGINT PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES account(id),
  amount NUMERIC( 18 , 2 ) NOT NULL DEFAULT 0,
  note varchar(200),
  CONSTRAINT fk_other FOREIGN KEY (other_id) REFERENCES other (id)
);
CREATE UNIQUE INDEX ux_entry ON entry (account_id, amount);
ALTER TABLE entry ADD COLUMN posted_at timestamp;`);
    const t = d.tables[0]!;
    expect(t).toMatchObject({ name: "entry", line: 2, primaryKey: { columns: ["id"], line: 3 } });
    expect(t.columns.map((c) => [c.name, c.type, c.nullable, c.line])).toEqual([
      ["id", "bigint", false, 3],
      ["account_id", "bigint", false, 4],
      ["amount", "numeric(18,2)", false, 5],
      ["note", "varchar(200)", true, 6],
    ]);
    expect(t.columns[2]!.default).toBe("0");
    expect(t.foreignKeys.map((f) => [f.table, f.columns, f.name])).toEqual([
      ["account", ["account_id"], undefined],
      ["other", ["other_id"], "fk_other"],
    ]);
    expect(d.indexes[0]).toMatchObject({
      name: "ux_entry",
      unique: true,
      columns: ["account_id", "amount"],
      line: 9,
    });
    expect(d.operations).toEqual([
      "create table entry",
      "create index ux_entry",
      "alter table entry add column posted_at",
    ]);
  });

  it("finds the tables a query reads and writes", async () => {
    expect(
      tablesInQuery(
        "SELECT a FROM entry e JOIN account a ON a.id = e.account_id WHERE x IN (SELECT 1 FROM holds)",
      ),
    ).toEqual([
      { table: "entry", access: "read" },
      { table: "account", access: "read" },
      { table: "holds", access: "read" },
    ]);
    expect(tablesInQuery("INSERT INTO entry (a) VALUES (?)")).toEqual([
      { table: "entry", access: "write" },
    ]);
    expect(tablesInQuery("DELETE FROM ledger.entry WHERE id = ?")).toEqual([
      { table: "entry", access: "write" },
    ]);
  });

  it("reads an upsert as a write to its table, not to a table called set", () => {
    // PostgreSQL, MySQL and a locking read: none of these UPDATEs names a table.
    expect(
      tablesInQuery(
        "insert into public_item (user_id, ref) values (?, ?) on conflict (user_id, ref) do update set shown = excluded.shown",
      ),
    ).toEqual([{ table: "public_item", access: "write" }]);
    expect(
      tablesInQuery("INSERT INTO hold (id, n) VALUES (?, ?) ON DUPLICATE KEY UPDATE n = n + 1"),
    ).toEqual([{ table: "hold", access: "write" }]);
    expect(tablesInQuery("SELECT id FROM account WHERE id = ? FOR UPDATE SKIP LOCKED")).toEqual([
      { table: "account", access: "read" },
    ]);
    expect(tablesInQuery("UPDATE account SET n = 1")).toEqual([
      { table: "account", access: "write" },
    ]);
  });

  it("doesn't read a comparison, a CTE's name or the database's own catalog as a table", () => {
    // Found by atticus scan review on a real estate (ADR 0072).
    expect(
      tablesInQuery(
        "insert into card_rating (a, b) values (?, ?) on conflict (a) do update set b = excluded.b where card_rating.b is distinct from excluded.b or card_rating.c is not distinct from excluded.c",
      ),
    ).toEqual([{ table: "card_rating", access: "write" }]);
    expect(
      tablesInQuery(
        "with mine as (select x from measured where h = ?), pool as (select m.x from measured m join consent c on c.u = m.u) select * from mine join pool on true",
      ),
    ).toEqual([
      { table: "measured", access: "read" },
      { table: "consent", access: "read" },
    ]);
    expect(
      tablesInQuery(
        "select table_name from information_schema.columns where column_name = 'user_id' union select relname from pg_catalog.pg_class",
      ),
    ).toEqual([]);
  });
});
