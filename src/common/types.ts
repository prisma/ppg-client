/**
 * Constant for binary parameter format (PostgreSQL bytea type).
 * Use with {@link byteArrayParameter} and {@link boundedByteStreamParameter}.
 */
export const BINARY = "binary",
    /**
     * Constant for text parameter format (PostgreSQL text type).
     * Use with {@link byteArrayParameter} and {@link boundedByteStreamParameter}.
     */
    TEXT = "text";

/**
 * Format for binary parameters - either "binary" or "text".
 */
export type ParameterFormat = typeof BINARY | typeof TEXT;

/**
 * A ReadableStream parameter with a predetermined byte length.
 * Used for streaming large binary or text data to PostgreSQL efficiently.
 */
export interface BoundedByteStreamParameter extends ReadableStream<Uint8Array> {
    /** Total number of bytes in the stream */
    readonly byteLength: number;
    /** Format: "binary" for bytea, "text" for text */
    readonly format: ParameterFormat;
}

/**
 * Creates a bounded byte stream parameter for efficient streaming of large binary/text data.
 *
 * @param readableStream - The stream of bytes to send
 * @param format - BINARY for bytea, TEXT for text encoding
 * @param byteLength - Total number of bytes in the stream (must be known upfront)
 * @returns A parameter suitable for query/exec methods
 *
 * @example
 * ```ts
 * const stream = getFileStream();
 * const param = boundedByteStreamParameter(stream, BINARY, 1024);
 * await client.query("INSERT INTO files (data) VALUES ($1)", param);
 * ```
 */
export function boundedByteStreamParameter(
    readableStream: ReadableStream<Uint8Array>,
    format: ParameterFormat,
    byteLength: number,
) {
    return Object.assign(readableStream, { byteLength, format });
}

export function isBoundedByteStreamParameter(x: unknown): x is BoundedByteStreamParameter {
    return x instanceof ReadableStream && "byteLength" in x && typeof x.byteLength === "number" && hasFormat(x);
}

function hasFormat(x: object) {
    return "format" in x && (x.format === TEXT || x.format === BINARY);
}

/**
 * A Uint8Array parameter with format specification.
 * Used for sending binary or text data to PostgreSQL.
 */
export interface ByteArrayParameter extends Uint8Array {
    /** Format: "binary" for bytea, "text" for text encoding */
    format: ParameterFormat;
}

/**
 * Creates a byte array parameter from a Uint8Array.
 *
 * @param array - The bytes to send
 * @param format - BINARY for bytea, TEXT for text encoding
 * @returns A parameter suitable for query/exec methods
 *
 * @example
 * ```ts
 * const bytes = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
 * const param = byteArrayParameter(bytes, BINARY);
 * await client.query("INSERT INTO files (data) VALUES ($1)", param);
 * ```
 */
export function byteArrayParameter(array: Uint8Array, format: ParameterFormat) {
    return Object.assign(array, { format });
}

export function isByteArrayParameter(x: unknown): x is ByteArrayParameter {
    return x instanceof Uint8Array && hasFormat(x);
}

/**
 * Raw parameter types accepted by query and exec methods.
 * Includes strings, null, and binary parameters.
 */
export type RawParameter = string | null | ByteArrayParameter | BoundedByteStreamParameter;

/**
 * Extended async iterator that can collect remaining elements into an array.
 * Useful when you want to stream initially, then collect the rest, or just
 * collect all the items at once.
 */
export interface CollectableIterator<T> extends AsyncIterableIterator<T> {
    /**
     * Collects the remaining (not yet consumed from the iterator) elements into an array.
     * Once called, further iteration will be empty.
     *
     * ```ts
     * const result = await client.query("SELECT * FROM users");
     * // Process first row manually
     * const { value: firstRow } = await result.rows.next();
     * // Collect the rest
     * const remainingRows = await result.rows.collect();
     * ```
     */
    collect(): Promise<T[]>;
}

/**
 * Wraps an AsyncIterableIterator to add the collect() method, making it a CollectableIterator.
 * Optionally transforms each item using the provided transform function.
 *
 * @param iterator - The source async iterable iterator
 * @param transform - Optional transformation function to apply to each item
 * @returns A collectable iterator with the same iteration behavior plus a collect() method
 *
 * @example
 * ```ts
 * async function* generator() {
 *   yield 1;
 *   yield 2;
 *   yield 3;
 * }
 *
 * // Without transformation
 * const iter = toCollectableIterator(generator());
 * const first = await iter.next(); // { value: 1, done: false }
 * const rest = await iter.collect(); // [2, 3]
 *
 * // With transformation
 * const doubled = toCollectableIterator(generator(), x => x * 2);
 * const all = await doubled.collect(); // [2, 4, 6]
 * ```
 */
export function toCollectableIterator<TSource, TResult = TSource>(
    iterator: AsyncIterableIterator<TSource>,
    transform?: (item: TSource) => TResult,
): CollectableIterator<TResult> {
    let collected = false;
    const transformFn = transform ?? ((item: TSource) => item as TSource & TResult);

    const collectableIterator: CollectableIterator<TResult> = {
        async next(): Promise<IteratorResult<TResult>> {
            if (collected) {
                return { value: undefined, done: true };
            }
            const result = await iterator.next();
            if (result.done) {
                return { value: undefined, done: true };
            }
            return { value: transformFn(result.value), done: false };
        },

        async collect(): Promise<TResult[]> {
            if (collected) {
                return [];
            }
            collected = true;

            const results: TResult[] = [];
            for await (const item of iterator) {
                results.push(transformFn(item));
            }
            return results;
        },

        [Symbol.asyncIterator](): AsyncIterableIterator<TResult> {
            return collectableIterator;
        },

        async return(value?: TResult): Promise<IteratorResult<TResult>> {
            collected = true;
            await iterator.return?.(value);
            return { value: undefined, done: true };
        },

        async throw(error?: unknown): Promise<IteratorResult<TResult>> {
            collected = true;
            await iterator.throw?.(error);
            return Promise.reject(error);
        },
    };

    return collectableIterator;
}

/**
 * Base error class for all PPG client errors.
 * All specific error types (ValidationError, DatabaseError, etc.) extend this class.
 */
export class GenericError extends Error {
    constructor(msg: string, opts?: ErrorOptions) {
        super(msg, opts);
        this.name = new.target.name;
    }
}

/**
 * Error thrown when input validation fails (invalid parameters, configuration, etc.).
 */
export class ValidationError extends GenericError {
    constructor(msg: string, opts?: ErrorOptions) {
        super(msg, opts);
        this.name = new.target.name;
    }
}

interface HttpResponseErrorDetails {
    readonly statusCode: number;
    readonly message: string;
}

/**
 * Error thrown when an HTTP request to the database fails.
 * Contains the HTTP status code for debugging.
 */
export class HttpResponseError extends GenericError {
    /** HTTP status code from the failed request */
    public readonly status: number;
    constructor({ message, statusCode }: HttpResponseErrorDetails, opts?: ErrorOptions) {
        super(message, opts);
        this.name = new.target.name;
        this.status = statusCode;
    }
}

interface WebSocketErrorDetails {
    readonly closureCode?: number;
    readonly closureReason?: string;
    readonly message: string;
}

/**
 * Error thrown when a WebSocket connection fails or closes unexpectedly.
 * Contains the WebSocket closure code and reason for debugging.
 */
export class WebSocketError extends GenericError {
    /** WebSocket closure code (e.g., 1000 for normal closure) */
    public readonly closureCode?: number;
    /** Human-readable closure reason */
    public readonly closureReason?: string;
    constructor({ message, closureCode, closureReason }: WebSocketErrorDetails, opts?: ErrorOptions) {
        super(`${message}${closureStr(closureCode, closureReason)}`, opts);
        this.name = new.target.name;
        this.closureCode = closureCode;
        this.closureReason = closureReason;
    }
}

function closureStr(closureCode: number | undefined, closureReason: string | undefined) {
    return !closureCode && !closureReason ? "" : ` (${closureCode} : ${closureReason})`;
}

/**
 * Details for database errors from PostgreSQL.
 */
export interface DatabaseErrorDetails {
    /** Error message from PostgreSQL */
    readonly message: string;
    /** PostgreSQL error code (e.g., "23505" for unique violation) */
    readonly code: string;
    /** Additional error fields from PostgreSQL */
    readonly [key: string]: string;
}

/**
 * Error thrown when PostgreSQL returns an error.
 * Contains the PostgreSQL error code and additional details for debugging.
 *
 * @example
 * ```ts
 * try {
 *   await client.query("INSERT INTO users (email) VALUES ($1)", "duplicate@example.com");
 * } catch (error) {
 *   if (error instanceof DatabaseError) {
 *     console.log(error.code); // "23505" (unique violation)
 *     console.log(error.details); // Additional PostgreSQL error fields
 *   }
 * }
 * ```
 */
export class DatabaseError extends GenericError {
    /** PostgreSQL error code (SQLSTATE) */
    readonly code: string;
    /** Additional error details from PostgreSQL (severity, hint, etc.) */
    readonly details: Record<string, string>;
    constructor(details: DatabaseErrorDetails, opts?: ErrorOptions) {
        super(details.message, opts);
        this.code = details.code;
        this.details = { ...details };
        // biome-ignore lint:
        delete this.details.code;
        // biome-ignore lint:
        delete this.details.message;
        this.name = new.target.name;
    }
}
