/**
 * Prisma Postgres low-level Serverless Client API Module.
 */

import type { CollectableIterator, RawParameter } from "../common/types.ts";

/**
 * Creates a new client.
 * @param config Client configuration.
 */
export declare function client(config: ClientConfig): Client;

/**
 * Base configuration shared between Client and Session configurations.
 */
interface BaseConfig {
    /**
     * Custom value parsers for specific PostgreSQL type OIDs.
     * These override the default parsing behavior for their respective types.
     */
    parsers?: ValueParser[];

    /**
     * Custom value serializers for specific JavaScript types.
     * These override the default serialization behavior.
     */
    serializers?: ValueSerializer<unknown>[];
}

/**
 * Configuration for the Prisma Postgres Serverless Client.
 */
export interface ClientConfig extends BaseConfig {
    /**
     * Use the direct TCP connection string for your Prisma Postgres database.
     */
    connectionString: string;
}

/**
 * Configuration for a database Session.
 * Allows per-session customization of parsing and serialization behavior.
 */
export interface SessionConfig extends BaseConfig { }

/**
 * A mixin interface allowing single query execution.
 * Implemented by both Client and Session.
 */
export interface Queryable {
    /**
     * Executes a SQL query and returns the full result set with streaming rows.
     * Use this for SELECT queries or commands where you need to access result data.
     *
     * @param sql - SQL query string with $1, $2, ... placeholders
     * @param params - Query parameters to substitute into placeholders
     * @returns Promise resolving to the result set (rowsAffected will be 0)
     *
     * ```ts
     * const result = await client.query("SELECT * FROM users WHERE id = $1", userId);
     * for await (const row of result.rows) {
     *   console.log(row.values);
     * }
     * ```
     */
    query(sql: string, ...params: unknown[]): Promise<Resultset>;

    /**
     * Executes a SQL command (INSERT, UPDATE, DELETE) and returns the number of affected rows.
     * This method is optimized for write operations where result data is not needed.
     *
     * @param sql - SQL command string with $1, $2, ... placeholders
     * @param params - Command parameters to substitute into placeholders
     * @returns Promise resolving to the number of rows affected
     *
     * ```ts
     * const affected = await client.exec("DELETE FROM users WHERE id = $1", userId);
     * console.log(`Deleted ${affected} user(s)`);
     * ```
     */
    exec(sql: string, ...params: unknown[]): Promise<number>;
}

/**
 * Prisma Postgres Serverless Client which allows
 * running individual raw queries or long running Sessions, which
 * can be used to implement interactive transactions.
 */
export interface Client extends Queryable {
    /**
     * Creates a new Session to run multiple queries interactively.
     * Sessions are useful for running transactions or maintaining state across queries.
     * The Session does not start an explicit transaction automatically - you must
     * issue BEGIN/COMMIT/ROLLBACK commands explicitly.
     *
     * @param config - Optional session configuration to customize parsing/serialization
     *                 behavior for this specific session, overriding the client defaults.
     * @returns A new Session instance
     *
     * ```ts
     * const session = client.newSession();
     * await session.query("BEGIN");
     * await session.query("INSERT INTO users VALUES ($1, $2)", "Alice", 25);
     * await session.query("COMMIT");
     * await session.close();
     * ```
     */
    newSession(config?: SessionConfig): Session;
}

/**
 * A Session represents a long-running stateful conversation with the
 * database. Multiple queries can be run while the Session is active.
 * The main use for Session is to run interactive transactions.
 */
export interface Session extends Queryable, AsyncDisposable {
    /**
     * Gracefully closes the current Session. Please notice
     * This will not run any implicit transaction command: the database
     * will automatically rollback any pending transaction when
     * closing without commit.
     *
     * This is an alias for [Symbol.asyncDispose]()
     */
    close(): PromiseLike<void>;

    /**
     * If true, the Session can still accept new queries. If false,
     * the Session should not be used anymore, and any query request
     * will immediately produce an error.
     */
    readonly active: boolean;
}

/**
 * Represents a single query parameter value that can be passed to a SQL query.
 *
 * - `string`: Text data
 * - `null`: SQL NULL value
 * - `ByteArrayParameter`: Fixed size byte array, carrying text or binary data
 * - `BoundedByteStreamParameter`: Streamed text or binary data, with a predetermined length
 */
export type QueryParameter = RawParameter;

/**
 * Query result set.
 */
export interface Resultset {
    /**
     * Resultset column descriptors, corresponding to the number of query result fields.
     */
    columns: Column[];

    /**
     * Resultset data rows async iterator. Allows streaming rows as they arrive
     * from the database, which is memory-efficient for large result sets.
     *
     * ```ts
     * const result = await client.query("SELECT * FROM users");
     *
     * // Stream rows one by one
     * for await (const row of result.rows) {
     *   const [id, name, email] = row.values;
     *   // process values
     * }
     *
     * // Or collect all rows at once
     * const allRows = await result.rows.collect();
     * ```
     */
    rows: CollectableIterator<Row>;
}

/**
 * Resultset column descriptor.
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
     * await client.run({
     *   sql: `SELECT typname FROM pg_type WHERE oid = $1`,
     *   parameters: [column.oid],
     * });
     * ```
     */
    oid: number;
}

/**
 * Single data row in a result set.
 */
export interface Row {
    /**
     * Array of values for this row. The number of elements in the array
     * corresponds to the number of column descriptors in the result set.
     *
     * ```ts
     * const [id, name, email] = row.values;
     * ```
     */
    values: unknown[];
}

/**
 * Custom parser for PostgreSQL values of a specific type OID.
 * A default set of parsers is provided for standard PostgreSQL types,
 * but these can be overridden by providing custom parsers in the client configuration.
 */
export interface ValueParser {
    /**
     * PostgreSQL type OID that this parser handles.
     */
    readonly typeOid: number;

    /**
     * Parses the raw string value from PostgreSQL into a JavaScript value.
     *
     * @param value - Raw string value from PostgreSQL, or null
     * @returns Parsed JavaScript value
     */
    parse<T>(value: string | null): T;
}

/**
 * Custom serializer for JavaScript values to PostgreSQL query parameters.
 * Serializers take precedence over the default encoding rules, which use
 * `toString()` for most types.
 *
 * Use serializers sparingly as the `supports()` check is invoked for every
 * parameter value until a matching serializer is found. If no match is found,
 * the default encoding rules apply.
 */
export interface ValueSerializer<T> {
    /**
     * Type guard that checks if this serializer can handle the given value.
     * This method is called for each parameter value until a match is found.
     *
     * @param value - The value to check
     * @returns True if this serializer supports the value type
     */
    supports(value: unknown): value is T;

    /**
     * Serializes the JavaScript value into a query parameter format.
     *
     * @param value - The value to serialize
     * @returns Serialized query parameter
     */
    serialize(value: T): QueryParameter;
}


export class DatabaseError extends Error {
    readonly code: string;
    readonly details: Record<string, string>;
    constructor(message: string, code: string, details: Record<string, string>) {
        super(message);
        this.code = code;
        this.details = details;
        delete details.code;
        delete details.message;
        this.name = new.target.name;
    }
}