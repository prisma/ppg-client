/**
 * Prisma Postgres low-level Serverless Client API Module.
 */

import type { CollectableIterator, RawParameter } from "../common/types.ts";
import { toCollectableIterator } from "../common/types.ts";
import type { NullableString } from "../transport/frames.ts";
import { httpTransport } from "../transport/http.ts";
import type { BaseTransport, Column, TransportConfig } from "../transport/shared.ts";
import { webSocketTransport } from "../transport/websocket.ts";

/**
 * Base configuration shared between Client and Session configurations.
 */
interface BaseConfig {
    /**
     * Custom value parsers for specific PostgreSQL type OIDs.
     * These override the default parsing behavior for their respective types.
     */
    parsers?: ValueParser<unknown>[];

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
export interface SessionConfig extends BaseConfig {}

/**
 * A mixin interface allowing single query execution.
 * Implemented by both Client and Session.
 */
export interface Statements {
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
export interface Client extends Statements {
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
     * using session = await client.newSession();
     * await session.query("BEGIN");
     * await session.query("INSERT INTO users VALUES ($1, $2)", "Alice", 25);
     * await session.query("COMMIT");
     * await session.close();
     * ```
     */
    newSession(config?: SessionConfig): Promise<Session>;
}

/**
 * A Session represents a long-running stateful conversation with the
 * database. Multiple queries can be run while the Session is active.
 * The main use for Session is to run interactive transactions.
 */
export interface Session extends Statements, Disposable {
    /**
     * Gracefully closes the current Session. Please notice
     * This will not run any implicit transaction command: the database
     * will automatically rollback any pending transaction when
     * closing without commit.
     *
     * This is an alias for [Symbol.dispose]()
     */
    close(): void;

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
export interface ValueParser<T> {
    /**
     * PostgreSQL type OID that this parser handles.
     */
    readonly oid: number;

    /**
     * Parses the raw string value from PostgreSQL into a JavaScript value.
     *
     * @param value - Raw string value from PostgreSQL, or null
     * @returns Parsed JavaScript value
     */
    parse(value: string | null): T;
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

/**
 * Parses a standard PostgreSQL connection string into TransportConfig.
 * Expects format: postgres://username:password@hostname:port/database
 */
function parseConnectionString(connectionString: string): TransportConfig {
    const url = new URL(connectionString);

    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
        throw new Error(`Invalid connection string protocol: ${url.protocol}. Expected "postgres:" or "postgresql:"`);
    }

    const username = url.username;
    const password = url.password;
    const hostname = url.hostname;
    const database = url.pathname.slice(1) || undefined; // Remove leading '/'

    if (!username || !password) {
        throw new Error("Connection string must include username and password");
    }

    // Construct HTTP endpoint (using port 80 for now)
    const httpPort = "54320";
    const endpoint = `http://${hostname}:${httpPort}`;

    return {
        endpoint,
        username,
        password,
        database,
    };
}

const passThrough = <T>(v: T) => v;
type NonNullParse = (value: string) => unknown;
const nullPassThrough =
    <T>(fn: NonNullParse) =>
    (v: string | null) =>
        v === null ? null : fn(v);

/**
 * Default value parsers for common PostgreSQL types.
 */
const DEFAULT_PARSERS: ValueParser<unknown>[] = [
    // Boolean
    { oid: 16, parse: (value) => value === "t" },
    // Int2 (smallint)
    { oid: 21, parse: nullPassThrough((value) => Number.parseInt(value, 10)) },
    // Int4 (integer)
    { oid: 23, parse: nullPassThrough((value) => Number.parseInt(value, 10)) },
    // Int8 (bigint) - parse as BigInt to preserve precision
    { oid: 20, parse: nullPassThrough(BigInt) },
    // Float4 (real)
    { oid: 700, parse: nullPassThrough((value) => Number.parseFloat(value)) },
    // Float8 (double precision)
    { oid: 701, parse: nullPassThrough((value) => Number.parseFloat(value)) },
    // Text
    { oid: 25, parse: passThrough },
    // Varchar
    { oid: 1043, parse: passThrough },
    // JSON
    { oid: 114, parse: nullPassThrough((value) => JSON.parse(value)) },
    // JSONB
    { oid: 3802, parse: nullPassThrough((value) => JSON.parse(value)) },
];

const serializeToString = (x: NonNullable<unknown>) => x.toString();

/**
 * Default value serializers for common JavaScript types.
 */
const DEFAULT_SERIALIZERS: ValueSerializer<unknown>[] = [
    // Date serializer
    {
        supports: (value): value is Date => value instanceof Date,
        serialize: (value: Date) => value.toISOString(),
    },
    // BigInt serializer
    {
        supports: (value): value is bigint => typeof value === "bigint",
        serialize: serializeToString,
    },
    // Boolean serializer
    {
        supports: (value): value is boolean => typeof value === "boolean",
        serialize: (value: boolean) => (value ? "t" : "f"),
    },
    // Number serializer
    {
        supports: (value): value is number => typeof value === "number",
        serialize: serializeToString,
    },
];

/**
 * Creates a new client.
 * @param config Client configuration.
 */
export function client(config: ClientConfig): Client {
    const transportConfig = parseConnectionString(config.connectionString);

    // Merge parsers: user parsers override defaults
    const parsersMap = [...DEFAULT_PARSERS, ...(config.parsers || [])].reduce(
        (map, parser) => map.set(parser.oid, parser),
        new Map<number, ValueParser<unknown>>(),
    );
    const parsers = [...parsersMap.values()];

    // Merge serializers: user serializers take precedence
    const serializers = [...(config.serializers || []), ...DEFAULT_SERIALIZERS];

    const transport = httpTransport(transportConfig);

    // Create client statements methods
    const statements = createStatements(transport, serializers, parsers);

    async function newSession(sessionConfig?: SessionConfig): Promise<Session> {
        const sessionTransport = webSocketTransport(transportConfig);
        await sessionTransport.connect();

        // Merge session-specific parsers/serializers with client defaults
        const sessionParsersMap =
            sessionConfig?.parsers?.reduce((map, parser) => map.set(parser.oid, parser), new Map(parsersMap)) ??
            new Map(parsersMap);
        const sessionParsers = [...sessionParsersMap.values()];

        const sessionSerializers = [
            ...(sessionConfig?.serializers || []),
            ...(config.serializers || []),
            ...DEFAULT_SERIALIZERS,
        ];

        // Create session statements methods
        const sessionStatements = createStatements(sessionTransport, sessionSerializers, sessionParsers);

        const session: Session = {
            ...sessionStatements,
            close() {
                sessionTransport.close();
            },

            get active() {
                return sessionTransport.isConnected();
            },

            [Symbol.dispose]() {
                this.close();
            },
        };

        return session;
    }

    return {
        ...statements,
        newSession,
    };
}

// Helper to create query/exec methods with the given serializers and parsers
function createStatements(
    transport: BaseTransport,
    serializers: ValueSerializer<unknown>[],
    parsers: ValueParser<unknown>[],
): Statements {
    function transformResponse(response: {
        columns: Column[];
        rows: CollectableIterator<(string | null)[]>;
    }): Resultset {
        const columns: Column[] = response.columns.map((col: Column) => ({
            name: col.name,
            oid: col.oid,
        }));

        const rows = toCollectableIterator(response.rows, (rawRow) => parseSessionRow(parsers, columns, rawRow));

        return { columns, rows };
    }

    return {
        async query(sql: string, ...params: unknown[]): Promise<Resultset> {
            const rawParams = serializeSessionParams(serializers, params);
            const response = await transport.statement("query", sql, rawParams);
            return transformResponse(response);
        },

        async exec(sql: string, ...params: unknown[]): Promise<number> {
            const rawParams = serializeSessionParams(serializers, params);
            const response = await transport.statement("exec", sql, rawParams);

            // the first row always has 1 column being the count of rows affected
            const firstRow = await response.rows.next();
            // sanity check. Should not be needed, but better to verify for protocol consistence.
            assertRowAffectedResult(firstRow);

            return Number.parseInt(firstRow.value[0], 10);
        },
    };
}

function serializeSessionParams(serializers: ValueSerializer<unknown>[], params: unknown[]): RawParameter[] {
    return params.map((param) => {
        if (param === null || param === undefined) {
            return null;
        }

        // Try custom serializers first, then default to string conversion
        const serializer = serializers.find((s) => s.supports(param));
        return serializer ? serializer.serialize(param) : typeof param === "string" ? param : String(param);
    });
}

function parseSessionRow(parsers: ValueParser<unknown>[], columns: Column[], rawValues: NullableString[]): Row {
    const values = rawValues.map((value, index) => {
        const columnOid = columns[index].oid;
        const parser = parsers.find((p) => p.oid === columnOid);
        return parser ? parser.parse(value) : value;
    });

    return { values };
}

function assertRowAffectedResult(
    x: IteratorResult<(string | null)[], unknown> | undefined,
): asserts x is { done: false; value: [string] } {
    if (!x || x.done || x.value?.length !== 1 || !x.value[0] || !/^\d+$/.test(x.value[0])) {
        throw new Error(`Protocol error: missing rowsAffected value in exec response: ${JSON.stringify(x)}`);
    }
}
