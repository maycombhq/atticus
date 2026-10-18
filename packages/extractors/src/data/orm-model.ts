/**
 * What every ORM reader produces: the physical tables a repo's mappings declare, with
 * where each fact was written. Names are database names (after the ORM's naming rules), so
 * the extractor can give them the same ids the migrations extractor gives.
 */
export interface Where {
  path: string;
  line: number;
}

export interface OrmColumn extends Where {
  name: string;
  type: string;
  /** Only when the mapping says so (or the type system implies it); otherwise left out. */
  nullable?: boolean;
}

export interface OrmForeignKey extends Where {
  columns: string[];
  refTable: string;
  refColumns: string[];
}

/** An index or unique constraint whose database name is known (declared or the ORM's default). */
export interface OrmIndex extends Where {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface OrmTable extends Where {
  name: string;
  tableKind: "table" | "view";
  columns: OrmColumn[];
  primaryKey?: Where & { columns: string[] };
  foreignKeys: OrmForeignKey[];
  indexes: OrmIndex[];
}

export interface OrmModel {
  tables: OrmTable[];
  /** postgresql, mysql, sqlserver, ... when the code or config names the database engine. */
  storeType?: string;
  /** Where the store is declared (a DbContext, a Prisma datasource); else the first table. */
  storeAt?: Where;
}
