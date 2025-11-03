export const BINARY = "binary",
    TEXT = "text";

export type ParameterFormat = typeof BINARY | typeof TEXT;

export interface BoundedByteStreamParameter extends ReadableStream<Uint8Array> {
    readonly byteLength: number;
    readonly format: ParameterFormat;
}

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

export interface ByteArrayParameter extends Uint8Array {
    format: ParameterFormat;
}

export function byteArrayParameter(array: Uint8Array, format: ParameterFormat) {
    return Object.assign(array, { format });
}

export function isByteArrayParameter(x: unknown): x is ByteArrayParameter {
    return x instanceof Uint8Array && hasFormat(x);
}

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
 * Marker base error class
 */
export class GenericError extends Error {
    constructor(msg: string, opts?: ErrorOptions) {
        super(msg, opts);
        this.name = new.target.name;
    }
}

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
export class HttpResponseError extends GenericError {
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

export class WebSocketError extends GenericError {
    public readonly closureCode?: number;
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

export interface DatabaseErrorDetails {
    readonly message: string;
    readonly code: string;
    readonly [key: string]: string;
}

export class DatabaseError extends GenericError {
    readonly code: string;
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
