import { describe, expect, it } from "vitest";
import {
  flattenProperties,
  flattenYaml,
  parseDdl,
  parseJava,
  parseXml,
  resolvePlaceholders,
  select,
  tablesInQuery,
  tokenize,
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
  const f = parseJava(src);

  it("skips comments and reads the package", () => {
    expect(f.packageName).toBe("forge.portal");
    expect(f.decls.flatMap((d) => d.annotations).map((a) => a.name)).not.toContain("Fake");
  });

  it("attaches annotations to the right declarations, with lines and attributes", () => {
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

  it("records method calls with literal arguments and where they are", () => {
    const c = f.calls.find((x) => x.method === "postForObject")!;
    expect(c).toMatchObject({
      receiver: "rest",
      args: ["${audit.url}/audit/events", undefined, undefined],
      line: 17,
    });
    expect(c.inMethod?.name).toBe("transfer");
  });

  it("tokenises text blocks and escapes", () => {
    const t = tokenize('String s = """\\n  SELECT *\\n  FROM entry""";\nchar c = \'\\n\';').filter(
      (x) => x.t === "str",
    );
    expect(t.length).toBe(2);
  });
});

describe("config", () => {
  it("flattens YAML with line numbers and indexes lists", () => {
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

  it("reads properties and resolves placeholders loosely, keeping unknown ones", () => {
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
  it("parses elements, attributes, text and lines, and selects paths", () => {
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
  it("reads tables, columns, keys and indexes with lines", () => {
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

  it("finds the tables a query reads and writes", () => {
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
});
