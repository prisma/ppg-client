import type { CollectableIterator } from "../common/types.ts";
import type { ClientConfig } from "./client.ts";

export declare function ppg(config: ClientConfig): Ppg;

/**
 * SQL template literal tag interface for query execution.
 * Provides a convenient template syntax for building parameterized queries.
 */
export interface Sql {
    /**
     * Executes a SQL query using template literal syntax and returns a stream of typed rows.
     *
     * @param strings - Template literal strings
     * @param values - Template literal interpolated values (used as query parameters)
     * @returns Iterator of typed result rows
     *
     * ```ts
     * const userId = 42;
     * const rows = sql<User>`SELECT * FROM users WHERE id = ${userId}`;
     *
     * // Option 1: Stream rows one by one
     * for await (const user of rows) {
     *   console.log(user);
     * }
     *
     * // Option 2: Collect all rows at once
     * const allUsers = await rows.collect();
     * ```
     */
    <R = unknown>(strings: TemplateStringsArray, ...values: unknown[]): CollectableIterator<R>;

    /**
     * Executes a SQL command using template literal syntax and returns the number of affected rows.
     *
     * @param strings - Template literal strings
     * @param values - Template literal interpolated values (used as command parameters)
     * @returns Promise resolving to the number of rows affected
     *
     * ```ts
     * const userId = 42;
     * const affected = await sql.exec`DELETE FROM users WHERE id = ${userId}`;
     * console.log(`Deleted ${affected} user(s)`);
     * ```
     */
    exec(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

export interface PpgQueryable {
    /**
     * SQL template literal tag for executing queries with type-safe results.
     *
     * ```ts
     * const userId = 42;
     * const rows = ppg.sql<User>`SELECT * FROM users WHERE id = ${userId}`;
     *
     * // Stream rows one by one
     * for await (const user of rows) {
     *   console.log(user);
     * }
     *
     * // Or collect all rows at once
     * const allUsers = await rows.collect();
     * ```
     */
    sql: Sql;

    /**
     * Executes a raw SQL query with parameterized placeholders and returns a stream of typed rows.
     *
     * @param sql - SQL query string with $1, $2, ... placeholders
     * @param params - Query parameters to substitute into placeholders
     * @returns Iterator of typed result rows
     *
     * ```ts
     * const rows = ppg.query<User>("SELECT * FROM users WHERE id = $1", userId);
     *
     * // Stream rows one by one
     * for await (const user of rows) {
     *   console.log(user);
     * }
     *
     * // Or collect all rows at once
     * const allUsers = await rows.collect();
     * ```
     */
    query<R = unknown>(sql: string, ...params: unknown[]): CollectableIterator<R>;

    /**
     * Executes a SQL command (INSERT, UPDATE, DELETE) and returns the number of affected rows.
     *
     * @param sql - SQL command string with $1, $2, ... placeholders
     * @param params - Command parameters to substitute into placeholders
     * @returns Promise resolving to the number of rows affected
     *
     * ```ts
     * const affected = await ppg.exec("DELETE FROM users WHERE id = $1", userId);
     * console.log(`Deleted ${affected} user(s)`);
     * ```
     */
    exec(sql: string, ...params: unknown[]): Promise<number>;
}

/**
 * High-level Prisma Postgres client interface with convenient query methods.
 */
export interface Ppg extends PpgQueryable {
    /**
     * Executes an interactive transaction, providing the `Sql` interface in the
     * given callback to run interactive queries/commands. The transaction BEGIN
     * is performed automatically before the callback is invoked, COMMIT is performed
     * automatically on return, ROLLBACK is performed automatically when throwing errors
     *
     * ```ts
     *   ppg.transaction(async (sql) => {
     *   // BEGIN is performed transparently
     *   const user = ['John', 'Doe'], userId = 13;
     *   await sql`INSERT INTO users VALUES (${userId}, ${user[0]}, ${user[1]})`;
     *
     *   const subId = 55;
     *   await sql`UPDATE subscriptions SET user_count = user_count + 1 WHERE id = ${subId}`;
     *   // COMMIT is performed automatically on return
     *   // ROLLBACK is performed automatically when throwing errors
     * })
     */
    transaction<T = void>(callback: (q: PpgQueryable) => Promise<T>): Promise<T>;

    /**
     * Executes a batch transaction with a fixed set of queries or commands. The transaction BEGIN
     * is performed automatically, followed by all queries/commands in sequence, then COMMIT is
     * performed automatically. ROLLBACK is performed automatically if any query fails.
     *
     * Use `{ query: "...", parameters: [...] }` for SELECT queries that return rows.
     * Use `{ exec: "...", parameters: [...] }` for INSERT/UPDATE/DELETE commands that return affected row counts.
     *
     * The tuple type determines the return types:
     * - Array types (e.g., `User[]`) expect a `query` statement
     * - Number types expect an `exec` statement
     *
     * @param queries - Variable number of query or exec statements matching the tuple type
     * @returns Promise resolving to a tuple of results matching the input types
     *
     * ```ts
     * const [orders, affected, users] = await ppg.batch<[Order[], number, User[]]>(
     *   { query: "SELECT * FROM orders WHERE id = $1", parameters: [orderId] },
     *   { exec: "UPDATE inventory SET stock = stock - $1 WHERE id = $2", parameters: [qty, inventoryId] },
     *   { query: "SELECT * FROM users WHERE id = $1", parameters: [userId] }
     * );
     * // orders: Order[], affected: number, users: User[]
     * ```
     */
    batch<T extends BatchTuple>(...queries: BatchQuery<T>): Promise<T>;

    /**
     * Starts building a batch transaction using a fluent API.
     * Useful for dynamically constructing batches or when you prefer method chaining.
     *
     * @returns A BatchQueryBuilder to chain query/exec calls and execute the batch
     *
     * ```ts
     * const [orders, affected, users] = await ppg.batch()
     *   .query<Order>("SELECT * FROM orders WHERE id = $1", orderId)
     *   .exec("UPDATE inventory SET stock = stock - $1 WHERE id = $2", qty, inventoryId)
     *   .query<User>("SELECT * FROM users WHERE id = $1", userId)
     *   .run();
     * // orders: Order[], affected: number, users: User[]
     * ```
     */
    batch(): BatchQueryBuilder<[]>;
}

/**
 * Type representing a tuple of batch result types.
 * Each element can be an array (for query results) or a number (for exec results).
 */
export type BatchTuple = readonly unknown[];

/**
 * Fluent builder interface for constructing batch transactions dynamically.
 * Allows chaining multiple query() and exec() calls, then executing the batch.
 */
export interface BatchQueryBuilder<T extends BatchTuple> {
    /**
     * Adds a SELECT query to the batch that returns typed rows.
     *
     * @param sql - SQL query string with $1, $2, ... placeholders
     * @param params - Query parameters
     * @returns Builder with the new query appended to the result tuple
     */
    query<R = unknown>(sql: string, ...params: unknown[]): BatchQueryBuilder<[...T, R[]]>;

    /**
     * Adds an INSERT/UPDATE/DELETE command to the batch that returns affected row count.
     *
     * @param sql - SQL command string with $1, $2, ... placeholders
     * @param params - Command parameters
     * @returns Builder with the affected row count appended to the result tuple
     */
    exec(sql: string, ...params: unknown[]): BatchQueryBuilder<[...T, number]>;

    /**
     * Runs the batch transaction and returns the tuple of results.
     *
     * @returns Tuple of results matching the chained query/exec calls
     */
    run(): Promise<T>;
}

/**
 * Statement for a SELECT query that returns rows.
 */
export interface QueryStatement {
    /**
     * SQL query string with $1, $2, ... placeholders
     */
    query: string;

    /**
     * Query parameters to substitute into placeholders
     */
    parameters?: unknown[];
}

/**
 * Statement for an INSERT/UPDATE/DELETE command that returns affected row count.
 */
export interface ExecStatement {
    /**
     * SQL command string with $1, $2, ... placeholders
     */
    exec: string;

    /**
     * Command parameters to substitute into placeholders
     */
    parameters?: unknown[];
}

/**
 * Mapped type that enforces correct statement types based on the result tuple.
 * - Number types in the tuple require ExecStatement
 * - Array types in the tuple require QueryStatement
 */
export type BatchQuery<T extends BatchTuple = BatchTuple> = {
    [K in keyof T]: T[K] extends number ? ExecStatement : T[K] extends Array<unknown> ? QueryStatement : never;
};
