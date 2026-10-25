/**
 * Whether a cited file is a database migration, by the file naming the common migration tools
 * use (ADR 0124 addendum B-places): the facts cite a column where it is declared, and when that
 * is a migration the store's migrations are known from the facts, so a change to its tables is a
 * new migration beside them rather than an edit of a schema file. `tool` is C1's Migration tool;
 * `version` is the part of the name the tool orders by. A schema file, an entity, a tool's own
 * scaffolding (an environment script, a designer or snapshot file) is no migration.
 */

export interface MigrationFile {
  tool: "flyway" | "liquibase" | "alembic" | "prisma" | "other";
  version: string;
}

const RULES: { re: RegExp; tool: MigrationFile["tool"] }[] = [
  // V1__orders.sql, V2_1__add_note.sql, a Java or Kotlin migration class (U<n>__ undoes one).
  { re: /(?:^|\/)[V](\d+(?:[._]\d+)*)__[^/]+\.(?:sql|java|kt)$/, tool: "flyway" },
  // A changelog folder's or file's change sets.
  {
    re: /(?:^|\/)(?:[^/]*changelog[^/]*\/(?:[^/]+\/)*)?([^/]*?)\.(?:xml|ya?ml|json|sql)$/i,
    tool: "liquibase",
  },
  // <alembic or migrations>/versions/<revision>_<slug>.py
  { re: /(?:^|\/)(?:alembic|migrations)\/versions\/([0-9A-Za-z]+)_[^/]*\.py$/, tool: "alembic" },
  // migrations/<timestamp>_<name>/migration.sql
  { re: /(?:^|\/)migrations\/([^/]+)\/migration\.sql$/, tool: "prisma" },
  // Migrations/<14-digit timestamp>_<Name>.cs (not its .Designer.cs)
  { re: /(?:^|\/)Migrations\/(\d{14})_[^/.]+\.cs$/, tool: "other" },
  // migrate/<timestamp>_<name>.rb
  { re: /(?:^|\/)db\/migrate\/(\d{8,})_[^/]+\.rb$/, tool: "other" },
  // migrations/<13-digit epoch>-<Name>.ts or a timestamped .js or .ts (knex, sequelize style)
  { re: /(?:^|\/)migrations?\/(\d{12,14})[-_][^/]+\.[cm]?[jt]s$/, tool: "other" },
  // migrations/0002_order_note.py
  { re: /(?:^|\/)migrations\/(\d{4})_[^/]+\.py$/, tool: "other" },
  // migrations/000003_add_note.up.sql (a down file undoes one), or a numbered .sql
  { re: /(?:^|\/)migrations?\/(\d+)[_-][^/]*?(?:\.up)?\.sql$/, tool: "other" },
];

export function migrationOf(path: string): MigrationFile | undefined {
  const p = path.replace(/\\/g, "/");
  if (/\.down\.sql$/i.test(p) || /\.Designer\.cs$/.test(p)) return undefined;
  for (const { re, tool } of RULES) {
    const m = re.exec(p);
    if (!m) continue;
    // A changelog is a file in a changelog folder, or a file named as one.
    if (tool === "liquibase" && !/changelog/i.test(p)) continue;
    if (!m[1]) continue;
    return { tool, version: m[1] };
  }
  return undefined;
}
