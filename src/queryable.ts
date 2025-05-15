/**
 * Result of the database query.
 */
export interface QueryResponse {
  /**
   * Column definitions.
   */
  columns: Column[];

  /**
   * Array of rows, where each row is an array of values with their indices
   * corresponding to the indices of the column definitions.
   */
  rows: unknown[][];
}

/**
 * Column definition.
 */
export interface Column {
  /**
   * Name of the column.
   */
  name: string;

  /**
   * Object identifier of the column type.
   *
   * If you need to know the column type name, you can use the `oid` to query
   * the `pg_type` catalog:
   *
   * ```ts
   * await client.query(
   *   `SELECT typname FROM pg_type WHERE oid = $1`,
   *   [column.oid]
   * );
   * ```
   */
  oid: number;
}

export interface Queryable {
  query(query: string, parameters: unknown[]): Promise<QueryResponse>;
}
