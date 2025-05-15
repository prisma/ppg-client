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
}

export type Deserialize = (value: unknown, oid: unknown) => unknown;

export function sqlFactory(client: Queryable, deserialize: Deserialize): Sql {
  return async function sql<T>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) {
    const query = strings.reduce(
      (acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ""),
      "",
    );

    const { columns, rows } = await client.query(query, values);

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
}
