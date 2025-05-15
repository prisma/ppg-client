import { Client } from "./client.ts";
import { type Deserialize, type Sql, sqlFactory } from "./sql.ts";

export {
  Client,
  type ClientOptions,
  RequestError,
  SqlError,
} from "./client.ts";
export type { Column, QueryResponse } from "./queryable.ts";
export { ConnectionStringError } from "./url.ts";
export type { Deserialize, Sql } from "./sql.ts";

/**
 * Connects to the specified Prisma Postgres database and returns a high-level
 * SQL client provided as a template literal tag function.
 *
 * ```ts
 * const sql = ppg("prisma+postgres://accelerate.prisma-data.net/?api_key=...");
 * const posts: Post[] = await sql`SELECT * FROM posts WHERE user_id = ${userId}`;
 * ```
 *
 * The interpolated values are automatically converted to SQL parameters to
 * prevent SQL injection attacks.
 *
 * You can also pass a custom deserializer function to convert the values based
 * on the column type.
 *
 * See also {@link Client} for the low-level client API.
 */
export function ppg(
  url: string,
  deserialize: Deserialize = (value) => value,
): Sql {
  const client = new Client({ connectionString: url });
  return sqlFactory(client, deserialize);
}

export default ppg;
