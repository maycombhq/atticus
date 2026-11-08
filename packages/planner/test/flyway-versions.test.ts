import { describe, expect, it } from "vitest";
import { migrationsOf, nextMigration } from "../src/stages/architecture.js";
import { estateOf } from "../src/stages/estate.js";

/**
 * Review round 31: Flyway versions with dots or underscores (V1_2__, V1.2__, V2024.01.15.1__)
 * are read whole, compared part by part, and the next one keeps the `__`.
 */
const mk = (f: string) => ({
  kind: "Migration",
  id: `m.${f}`,
  dataStore: "db.ledger",
  file: `src/main/resources/db/migration/${f}`,
  tool: "flyway",
  evidence: [{ repo: "forge-ledger", path: f, line: 1 }],
});
const store = (files: string[]) => migrationsOf(estateOf(files.map(mk) as never, []), "db.ledger");

describe("Flyway's dotted and underscored versions", () => {
  it("reads V1_1__ to V1_10__ as versions, newest first, and suggests V1_11__", () => {
    const m = store(["V1_1__init.sql", "V1_2__add_acct.sql", "V1_10__add_idx.sql"]);
    expect(m.files).toEqual(["V1_10__add_idx.sql", "V1_2__add_acct.sql", "V1_1__init.sql"]);
    expect(nextMigration(m, "<what_it_does>")).toBe("V1_11__<what_it_does>.sql");
  });

  it("keeps a dotted version's dots and zeros: V1.2__ then V1.3__, V2024.01.15.1__ then .2", () => {
    expect(nextMigration(store(["V1.1__init.sql", "V1.2__add.sql"]), "x")).toBe("V1.3__x.sql");
    expect(nextMigration(store(["V2024.01.14.1__init.sql", "V2024.01.15.1__add.sql"]), "x")).toBe(
      "V2024.01.15.2__x.sql",
    );
  });

  it("keeps plain numbering as it was: V3__ then V4__", () => {
    expect(nextMigration(store(["V2__a.sql", "V3__b.sql"]), "x")).toBe("V4__x.sql");
  });
});
