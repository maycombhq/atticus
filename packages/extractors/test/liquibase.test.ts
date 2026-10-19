import { describe, expect, it } from "vitest";
import type { CatalogRecord } from "@maycombhq/core";
import { memoryRepo, scanRepo } from "@maycombhq/sdk";
import { migrationsExtractor } from "../src/index.js";

const SHA = "a".repeat(40);
const info = { component: "cards-svc", system: "cards" };

/** The design a scan gives: tables, columns and indexes, without where they came from. */
const design = (recs: CatalogRecord[]) =>
  recs
    .filter((r) => ["DataStore", "Table", "Column", "IndexConstraint"].includes(r.kind))
    .map((r) => {
      const { evidence: _e, ...rest } = r as unknown as Record<string, unknown>;
      return rest;
    })
    .sort((a, b) => (`${a.kind}/${a.id}` < `${b.kind}/${b.id}` ? -1 : 1));

const flyway = memoryRepo("cards", SHA, {
  "src/main/resources/db/migration/V1__cards.sql": `CREATE TABLE card (
  id BIGINT NOT NULL PRIMARY KEY,
  account_id BIGINT NOT NULL,
  pan_hash VARCHAR(64) NOT NULL
);`,
  // Nested folders under db/migration are Flyway's too.
  "src/main/resources/db/migration/2026/V2__limits.sql": `ALTER TABLE card ADD COLUMN daily_limit DECIMAL(12,2);
ALTER TABLE card RENAME COLUMN pan_hash TO card_hash;`,
  "src/main/resources/db/migration/2026/V3__index.sql":
    "CREATE INDEX idx_card_account ON card (account_id);",
});

const liquibase = memoryRepo("cards", SHA, {
  "src/main/resources/db/changelog/db.changelog-master.yaml": `databaseChangeLog:
  - include:
      file: db/changelog/001-cards.xml
  - include:
      file: db/changelog/002-limits.yaml
  - include:
      file: db/changelog/003-index.sql
`,
  "src/main/resources/db/changelog/001-cards.xml": `<?xml version="1.0" encoding="UTF-8"?>
<databaseChangeLog xmlns="http://www.liquibase.org/xml/ns/dbchangelog">
  <changeSet id="1" author="cards-team">
    <createTable tableName="card">
      <column name="id" type="BIGINT"><constraints primaryKey="true" nullable="false"/></column>
      <column name="account_id" type="BIGINT"><constraints nullable="false"/></column>
      <column name="pan_hash" type="VARCHAR(64)"><constraints nullable="false"/></column>
    </createTable>
  </changeSet>
</databaseChangeLog>`,
  "src/main/resources/db/changelog/002-limits.yaml": `databaseChangeLog:
  - changeSet:
      id: 2
      author: cards-team
      changes:
        - addColumn:
            tableName: card
            columns:
              - column:
                  name: daily_limit
                  type: DECIMAL(12,2)
        - renameColumn:
            tableName: card
            oldColumnName: pan_hash
            newColumnName: card_hash
`,
  "src/main/resources/db/changelog/003-index.sql": `--liquibase formatted sql

--changeset cards-team:3
CREATE INDEX idx_card_account ON card (account_id);
`,
});

describe("Liquibase changelogs (XML, YAML, formatted SQL) and nested Flyway folders", () => {
  it("give the same database design as the same changes written for Flyway", async () => {
    const f = await scanRepo({ repo: flyway, extractors: [migrationsExtractor], repoInfo: info });
    const l = await scanRepo({
      repo: liquibase,
      extractors: [migrationsExtractor],
      repoInfo: info,
    });
    expect(f.rejected).toEqual([]);
    expect(l.rejected).toEqual([]);
    const columns = (recs: CatalogRecord[]) =>
      recs
        .filter((r) => r.kind === "Column")
        .map((r) => r.id)
        .sort();
    expect(columns(f.records)).toEqual([
      "cards-db.card.account-id",
      "cards-db.card.card-hash",
      "cards-db.card.daily-limit",
      "cards-db.card.id",
    ]);
    expect(design(l.records)).toEqual(design(f.records));
  });

  it("records each change set as a Liquibase migration, in the master changelog's order", async () => {
    const l = await scanRepo({
      repo: liquibase,
      extractors: [migrationsExtractor],
      repoInfo: info,
    });
    const migrations = l.records
      .filter((r) => r.kind === "Migration")
      .map((r) => {
        const m = r as unknown as { version: string; tool: string; file: string };
        return `${m.version} ${m.tool} ${m.file.split("/").pop()}`;
      });
    expect(migrations).toEqual([
      "1 liquibase 001-cards.xml",
      "2 liquibase 002-limits.yaml",
      "3 liquibase 003-index.sql",
    ]);
  });
});
