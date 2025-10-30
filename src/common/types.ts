export const BINARY = "binary",
    TEXT = "text";

export type ParameterFormat = typeof BINARY | typeof TEXT;

export interface BoundedByteStream extends ReadableStream<Uint8Array> {
    readonly byteLength: number;
    readonly format: ParameterFormat;
}

export function boundedByteStream(
    readableStream: ReadableStream<Uint8Array>,
    format: ParameterFormat,
    byteLength: number,
) {
    return Object.assign(readableStream, { byteLength, format });
}

export function isBoundedByteStream(x: unknown): x is BoundedByteStream {
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

export type RawParameter = string | null | ByteArrayParameter | BoundedByteStream;

/**
 * Extended async iterator that can collect remaining elements into an array.
 * Useful when you want to stream initially, then collect the rest.
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
 *
 * @param iterator - The source async iterable iterator
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
 * const iter = toCollectableIterator(generator());
 * const first = await iter.next(); // { value: 1, done: false }
 * const rest = await iter.collect(); // [2, 3]
 * ```
 */
export function toCollectableIterator<T>(iterator: AsyncIterableIterator<T>): CollectableIterator<T> {
    let collected = false;

    const collectableIterator: CollectableIterator<T> = {
        async next(): Promise<IteratorResult<T>> {
            if (collected) {
                return { value: undefined, done: true };
            }
            return iterator.next();
        },

        async collect(): Promise<T[]> {
            if (collected) {
                return [];
            }
            collected = true;

            const results: T[] = [];
            for await (const item of iterator) {
                results.push(item);
            }
            return results;
        },

        [Symbol.asyncIterator](): AsyncIterableIterator<T> {
            return collectableIterator;
        },

        return(value): Promise<IteratorResult<T>> {
            collected = true;
            return iterator.return?.(value) ?? Promise.resolve({ value: undefined, done: true });
        },

        throw(error): Promise<IteratorResult<T>> {
            collected = true;
            return iterator.throw?.(error) ?? Promise.reject(error);
        },
    };

    return collectableIterator;
}
