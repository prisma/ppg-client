import type { CollectableIterator } from "../common/types.ts";
import { toCollectableIterator } from "../common/types.ts";
import { type ClientConfig, type Statements, client } from "./client.ts";

export interface PrismaPostgresConfig extends ClientConfig {}

/**
 * SQL template literal tag interface for query execution.
 * Provides a convenient template syntax for building parameterized queries.
 */
export interface SqlTemplateStatements {
    /**
     * Executes a SQL query using template literal syntax and returns a stream of typed rows.
     *
     * @param strings - Template literal strings
     * @param values - Template literal interpolated values (used as query parameters)
     * @returns Iterator of typed result rows
     *
     * ```ts
     * const userId = 42;
     * const rows = ppg.sql<User>`SELECT * FROM users WHERE id = ${userId}`;
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
    <R extends NonNullable<object> = Record<string, unknown>>(
        strings: TemplateStringsArray,
        ...values: unknown[]
    ): CollectableIterator<R>;

    /**
     * Executes a SQL command using template literal syntax and returns the number of affected rows.
     *
     * @param strings - Template literal strings
     * @param values - Template literal interpolated values (used as command parameters)
     * @returns Promise resolving to the number of rows affected
     *
     * ```ts
     * const userId = 42;
     * const affected = await ppg.sql.exec`DELETE FROM users WHERE id = ${userId}`;
     * console.log(`Deleted ${affected} user(s)`);
     * ```
     */
    exec(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

export interface PrismaPostgresStatements {
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
    sql: SqlTemplateStatements;

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
    query<R extends NonNullable<object> = Record<string, unknown>>(
        sql: string,
        ...params: unknown[]
    ): CollectableIterator<R>;

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

export interface PrismaPostgresTransactions {
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
    transaction<T = void>(callback: (statements: PrismaPostgresStatements) => Promise<T>): Promise<T>;

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
    batch<T extends BatchTuple>(...statements: StatementsBatch<T>): Promise<T>;
}

/**
 * High-level Prisma Postgres client interface with convenient query methods.
 */
export interface PrismaPostgres extends PrismaPostgresStatements, PrismaPostgresTransactions {}

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
    query<R extends NonNullable<object> = Record<string, unknown>>(
        sql: string,
        ...params: unknown[]
    ): BatchQueryBuilder<[...T, R[]]>;

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
export type StatementsBatch<T extends BatchTuple = BatchTuple> = {
    [K in keyof T]: T[K] extends number ? ExecStatement : T[K] extends Array<unknown> ? QueryStatement : never;
};

type SupportedStatement = QueryStatement | ExecStatement;

/**
 * Creates a new high-level Prisma Postgres client with convenient query methods
 * including SQL template literals and transaction support.
 *
 * @param config - Client configuration with connection string and optional parsers/serializers
 * @returns PrismaPostgres client instance
 *
 * ```ts
 * const ppg = prismaPostgres({ connectionString: "postgres://user:pass@host:5432/db" });
 *
 * // SQL template literals
 * const users = await ppg.sql<User>`SELECT * FROM users WHERE id = ${userId}`.collect();
 *
 * // Raw queries
 * const rows = await ppg.query<User>("SELECT * FROM users WHERE id = $1", userId).collect();
 *
 * // Transactions
 * await ppg.transaction(async (sql) => {
 *   await sql`INSERT INTO users VALUES (${userId}, ${name})`;
 *   await sql`UPDATE subscriptions SET user_count = user_count + 1`;
 * });
 * ```
 */
export function prismaPostgres(config: PrismaPostgresConfig): PrismaPostgres {
    const lowLevelClient = client(config);

    // Create top-level statement methods
    const prismaStatements = createPrismaStatements(lowLevelClient);

    async function transaction<T = void>(callback: (statements: PrismaPostgresStatements) => Promise<T>): Promise<T> {
        using session = await lowLevelClient.newSession();
        const sessionStatements = createPrismaStatements(session);

        try {
            const beginPromise = session.exec("BEGIN");
            const result = await Promise.all([beginPromise, callback(sessionStatements)]);
            await session.exec("COMMIT");
            return result[1];
        } catch (error) {
            await session.exec("ROLLBACK");
            throw error;
        }
    }

    function batchWithQueries<T extends BatchTuple>(...statements: SupportedStatement[]): Promise<T> {
        return transaction(async (stmt) => {
            const results: unknown[] = [];

            for (const statement of statements) {
                if ("query" in statement) {
                    const rows = await stmt.query(statement.query, ...(statement.parameters || [])).collect();
                    results.push(rows);
                } else {
                    const affected = await stmt.exec(statement.exec, ...(statement.parameters || []));
                    results.push(affected);
                }
            }

            return results as BatchTuple as T;
        });
    }

    function batch<T extends BatchTuple>(...queries: StatementsBatch<T>): Promise<T>;
    function batch(): BatchQueryBuilder<[]>;
    function batch<T extends BatchTuple>(...queries: StatementsBatch<T>): Promise<T> | BatchQueryBuilder<[]> {
        if (queries.length === 0) {
            return createBatchQueryBuilder([]);
        }
        return batchWithQueries(...queries);
    }

    function createBatchQueryBuilder<T extends BatchTuple>(
        statements: (QueryStatement | ExecStatement)[],
    ): BatchQueryBuilder<T> {
        return {
            query<R extends NonNullable<unknown>>(sql: string, ...params: unknown[]): BatchQueryBuilder<[...T, R[]]> {
                return createBatchQueryBuilder([...statements, { query: sql, parameters: params }]);
            },

            exec(sql: string, ...params: unknown[]): BatchQueryBuilder<[...T, number]> {
                return createBatchQueryBuilder([...statements, { exec: sql, parameters: params }]);
            },

            run(): Promise<T> {
                return batchWithQueries(...statements);
            },
        };
    }

    return {
        ...prismaStatements,
        transaction,
        batch,
    };
}

// Helper: convert template literals to SQL string and parameters
function templateToSqlParams(strings: TemplateStringsArray, values: unknown[]): [string, unknown[]] {
    let sql = strings[0];
    for (let i = 0; i < values.length; i++) {
        sql += `$${i + 1}${strings[i + 1]}`;
    }
    return [sql, values];
}

// Helper: convert row values array to object with column names as keys
function rowToObject<R extends NonNullable<unknown>>(columns: { name: string }[], values: unknown[]): R {
    const obj = {} as Record<string, unknown>;
    for (let i = 0; i < columns.length; i++) {
        obj[columns[i].name] = values[i];
    }
    return obj as R;
}

// Helper: create statement methods from a low-level Statements instance
function createPrismaStatements(statements: Statements): PrismaPostgresStatements {
    async function* rowObjectsGenerator<R extends NonNullable<object>>(sql: string, params: unknown[]) {
        const result = await statements.query(sql, ...params);
        for await (const row of result.rows) {
            yield rowToObject<R>(result.columns, row.values);
        }
    }

    function sqlTag<R extends NonNullable<object>>(
        strings: TemplateStringsArray,
        ...values: unknown[]
    ): CollectableIterator<R> {
        const [sql, params] = templateToSqlParams(strings, values);
        return toCollectableIterator(rowObjectsGenerator(sql, params));
    }

    sqlTag.exec = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
        const [sql, params] = templateToSqlParams(strings, values);
        return statements.exec(sql, ...params);
    };

    return {
        sql: sqlTag,

        query<R extends NonNullable<unknown>>(sql: string, ...params: unknown[]): CollectableIterator<R> {
            return toCollectableIterator(rowObjectsGenerator(sql, params));
        },

        async exec(sql: string, ...params: unknown[]): Promise<number> {
            return statements.exec(sql, ...params);
        },
    };
}
