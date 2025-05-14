export interface Queryable {
  query(query: string, parameters: unknown[]): Promise<unknown>;
}

/**
 * Template literal tag function that immediately executes the query.
 */
export type Sql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown>;

export function sqlFactory(client: Queryable): Sql {
  return async function sql(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) {
    const query = strings.reduce(
      (acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ""),
      "",
    );
    return await client.query(query, values);
  };
}
