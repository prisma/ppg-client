import { Client } from "./client.ts";
import { type Sql, sqlFactory } from "./sql.ts";

export { ConnectionStringError } from "./url.ts";
export { Client, RequestError } from "./client.ts";

/**
 * Connects to the specified Prisma Postgres database and returns a high-level
 * SQL client provided as a template literal tag function.
 *
 * ```ts
 * const sql = createClient("prisma+postgres://accelerate.prisma-data.net/?api_key=...");
 * const user = await sql`SELECT * FROM users WHERE id = ${id}`;
 * ```
 *
 * The interpolated values are automatically converted to SQL parameters to
 * prevent SQL injection attacks.
 *
 * See also {@link Client} for the low-level client API.
 */
export function createClient(url: string): Sql {
  const client = new Client({ connectionString: url });
  return sqlFactory(client);
}
