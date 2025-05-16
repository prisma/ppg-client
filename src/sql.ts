import type { Queryable } from "./queryable.ts";

/**
 * Template literal tag function that executes the query.
 *
 * ```ts
 * const [user] = await sql<User>`SELECT * FROM users WHERE id = ${id}`;
 * ```
 */
export interface Sql {
  <Record = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<Record[]>;

  /**
   * Executes a raw query defined as a string with placeholders and the list
   * of parameters.
   *
   * ```ts
   * const [user] = await sql.query<User>("SELECT * FROM users WHERE id = $1", [id]);
   * ```
   */
  query<Record>(query: string, ...params: unknown[]): Promise<Record[]>;
}

export type Deserialize = (value: unknown, oid: unknown) => unknown;

export function sqlFactory(client: Queryable, deserialize: Deserialize): Sql {
  const query = async <T>(query: string, params: unknown[]): Promise<T[]> => {
    const { columns, rows } = await client.query(query, params);

    return rows.map(
      (row) =>
        Object.fromEntries(
          columns.map((column, i) => [
            column.name,
            deserialize(row[i], column.oid),
          ]),
        ) as T,
    );
  };

  const sql = async <T>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> => {
    const queryString = strings.reduce(
      (acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ""),
      "",
    );

    return query(queryString, values);
  };

  sql.query = query;

  return sql;
}
