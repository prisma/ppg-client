import { describe, it, expect } from "vitest";
import { toCollectableIterator, boundedByteStreamParameter, isBoundedByteStreamParameter, BINARY } from "../../src/common/types";

describe("CollectableIterator", () => {
    describe("Basic Iteration", () => {
        it("should iterate over all values", async () => {
            async function* generator() {
                yield 1;
                yield 2;
                yield 3;
            }

            const iter = toCollectableIterator(generator());
            const collected: number[] = [];

            for await (const value of iter) {
                collected.push(value);
            }

            expect(collected).toEqual([1, 2, 3]);
        });

        it("should support manual next() calls", async () => {
            async function* generator() {
                yield 'a';
                yield 'b';
                yield 'c';
            }

            const iter = toCollectableIterator(generator());

            const first = await iter.next();
            expect(first.done).toBe(false);
            expect(first.value).toBe('a');

            const second = await iter.next();
            expect(second.done).toBe(false);
            expect(second.value).toBe('b');

            const third = await iter.next();
            expect(third.done).toBe(false);
            expect(third.value).toBe('c');

            const fourth = await iter.next();
            expect(fourth.done).toBe(true);
        });
    });

    describe("collect() method", () => {
        it("should collect all remaining values", async () => {
            async function* generator() {
                yield 1;
                yield 2;
                yield 3;
            }

            const iter = toCollectableIterator(generator());
            const result = await iter.collect();

            expect(result).toEqual([1, 2, 3]);
        });

        it("should collect remaining values after partial iteration", async () => {
            async function* generator() {
                yield 1;
                yield 2;
                yield 3;
                yield 4;
                yield 5;
            }

            const iter = toCollectableIterator(generator());

            // Consume first two items
            expect((await iter.next()).value).toEqual(1);
            expect((await iter.next()).value).toEqual(2);

            // Collect the rest
            const result = await iter.collect();

            expect(result).toEqual([3, 4, 5]);
        });

        it("should return empty array when called after collection is complete", async () => {
            async function* generator() {
                yield 1;
                yield 2;
            }

            const iter = toCollectableIterator(generator());

            // First collect
            const first = await iter.collect();
            expect(first).toEqual([1, 2]);

            // Second collect should return empty array
            const second = await iter.collect();
            expect(second).toEqual([]);
        });

        it("should return empty array when collecting an already exhausted iterator", async () => {
            async function* generator() {
                yield 1;
                yield 2;
            }

            const iter = toCollectableIterator(generator());

            // Exhaust the iterator
            for await (const _ of iter) {
                // consume all
            }

            // Try to collect
            const result = await iter.collect();
            expect(result).toEqual([]);
        });
    });

    describe("Post-collection behavior", () => {
        it("should return done: true for next() after collect()", async () => {
            async function* generator() {
                yield 1;
                yield 2;
            }

            const iter = toCollectableIterator(generator());

            await iter.collect();

            // After collection, next() should return done
            const result = await iter.next();
            expect(result.done).toBe(true);
            expect(result.value).toBeUndefined();
        });

        it("should not yield any values in for-await loop after collect()", async () => {
            async function* generator() {
                yield 1;
                yield 2;
                yield 3;
            }

            const iter = toCollectableIterator(generator());

            await iter.collect();

            // Try to iterate - should get nothing
            const collected: number[] = [];
            for await (const value of iter) {
                collected.push(value);
            }

            expect(collected).toEqual([]);
        });
    });

    describe("return() method", () => {
        it("should mark iterator as collected when return() is called", async () => {
            async function* generator() {
                yield 1;
                yield 2;
                yield 3;
            }

            const iter = toCollectableIterator(generator());

            // Call return
            const result = await iter.return!();
            expect(result.done).toBe(true);

            // Further iteration should return empty
            const next = await iter.next();
            expect(next.done).toBe(true);
        });

        it("should call underlying iterator's return() if it exists", async () => {
            let returnCalled = false;

            const mockIterator: AsyncIterableIterator<number> = {
                async next() {
                    return { value: 1, done: false };
                },
                async return(value) {
                    returnCalled = true;
                    return { value, done: true };
                },
                [Symbol.asyncIterator]() {
                    return this;
                }
            };

            const iter = toCollectableIterator(mockIterator);

            await iter.return!();

            expect(returnCalled).toBe(true);
        });

        it("should accept a value parameter", async () => {
            async function* generator() {
                yield 1;
                yield 2;
            }

            const iter = toCollectableIterator(generator());

            const result = await iter.return!(42);
            expect(result.done).toBe(true);
        });

        it("should prevent collect() from working after return()", async () => {
            async function* generator() {
                yield 1;
                yield 2;
                yield 3;
            }

            const iter = toCollectableIterator(generator());

            await iter.return!();

            const collected = await iter.collect();
            expect(collected).toEqual([]);
        });

        it("should use fallback when iterator doesn't have return() method", async () => {
            // Create an iterator without return() method
            const mockIterator: AsyncIterableIterator<number> = {
                async next() {
                    return { value: 1, done: false };
                },
                // No return() method defined
                [Symbol.asyncIterator]() {
                    return this;
                }
            };

            const iter = toCollectableIterator(mockIterator);

            // Should use the fallback: Promise.resolve({ value: undefined, done: true })
            const result = await iter.return!(42);
            expect(result.done).toBe(true);
            expect(result.value).toBeUndefined();

            // Iterator should be marked as collected
            const next = await iter.next();
            expect(next.done).toBe(true);
        });
    });

    describe("throw() method", () => {
        it("should mark iterator as collected when throw() is called", async () => {
            async function* generator() {
                yield 1;
                yield 2;
            }

            const iter = toCollectableIterator(generator());

            // Call throw and catch the error
            await expect(iter.throw!(new Error('test error'))).rejects.toThrow('test error');

            // Further iteration should return empty
            const next = await iter.next();
            expect(next.done).toBe(true);
        });

        it("should call underlying iterator's throw() if it exists", async () => {
            let throwCalled = false;
            let errorMessage = '';

            const mockIterator: AsyncIterableIterator<number> = {
                async next() {
                    return { value: 1, done: false };
                },
                async throw(error) {
                    throwCalled = true;
                    errorMessage = error.message;
                    return Promise.reject(error);
                },
                [Symbol.asyncIterator]() {
                    return this;
                }
            };

            const iter = toCollectableIterator(mockIterator);

            try {
                await iter.throw!(new Error('custom error'));
            } catch {
                // Expected
            }

            expect(throwCalled).toBe(true);
            expect(errorMessage).toBe('custom error');
        });

        it("should prevent collect() from working after throw()", async () => {
            async function* generator() {
                yield 1;
                yield 2;
            }

            const iter = toCollectableIterator(generator());

            try {
                await iter.throw!(new Error('test'));
            } catch {
                // Expected
            }

            const collected = await iter.collect();
            expect(collected).toEqual([]);
        });

        it("should use fallback when iterator doesn't have throw() method", async () => {
            // Create an iterator without throw() method
            const mockIterator: AsyncIterableIterator<number> = {
                async next() {
                    return { value: 1, done: false };
                },
                // No throw() method defined
                [Symbol.asyncIterator]() {
                    return this;
                }
            };

            const iter = toCollectableIterator(mockIterator);

            // Should use the fallback: Promise.reject(error)
            const testError = new Error('fallback test error');
            await expect(iter.throw!(testError)).rejects.toThrow('fallback test error');

            // Iterator should be marked as collected
            const next = await iter.next();
            expect(next.done).toBe(true);
        });
    });

    describe("Symbol.asyncIterator", () => {
        it("should return itself when Symbol.asyncIterator is called", async () => {
            async function* generator() {
                yield 1;
            }

            const iter = toCollectableIterator(generator());
            const iterSelf = iter[Symbol.asyncIterator]();

            expect(iterSelf).toBe(iter);
        });
    });

    describe("Edge Cases", () => {
        it("should handle empty generators", async () => {
            async function* generator() {
                // Empty
            }

            const iter = toCollectableIterator(generator());
            const result = await iter.collect();

            expect(result).toEqual([]);
        });

        it("should handle generators that yield undefined", async () => {
            async function* generator() {
                yield undefined;
                yield undefined;
            }

            const iter = toCollectableIterator(generator());
            const result = await iter.collect();

            expect(result).toEqual([undefined, undefined]);
        });

        it("should handle generators that yield null", async () => {
            async function* generator() {
                yield null;
                yield null;
            }

            const iter = toCollectableIterator(generator());
            const result = await iter.collect();

            expect(result).toEqual([null, null]);
        });

        it("should handle mixed consumption patterns", async () => {
            async function* generator() {
                yield 1;
                yield 2;
                yield 3;
                yield 4;
                yield 5;
            }

            const iter = toCollectableIterator(generator());

            // Get first item with next()
            const first = await iter.next();
            expect(first.value).toBe(1);

            // Get second item with next()
            const second = await iter.next();
            expect(second.value).toBe(2);

            // Collect the rest
            const rest = await iter.collect();
            expect(rest).toEqual([3, 4, 5]);
        });
    });
});

describe("BoundedByteStream", () => {
    describe("boundedByteStream()", () => {
        it("should create a BoundedByteStream from ReadableStream", () => {
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new Uint8Array([1, 2, 3]));
                    controller.close();
                }
            });

            const bounded = boundedByteStreamParameter(stream, BINARY, 3);

            expect(bounded.byteLength).toBe(3);
            expect(bounded instanceof ReadableStream).toBe(true);
        });

        it("should preserve the original stream", async () => {
            const data = new Uint8Array([1, 2, 3, 4, 5]);
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(data);
                    controller.close();
                }
            });

            const bounded = boundedByteStreamParameter(stream, BINARY, data.byteLength);
            const reader = bounded.getReader();
            const result = await reader.read();

            expect(result.value).toEqual(data);
        });
    });

    describe("isBoundedByteStream()", () => {
        it("should return true for BoundedByteStream", () => {
            const stream = new ReadableStream<Uint8Array>();
            const bounded = boundedByteStreamParameter(stream, BINARY, 100);

            expect(isBoundedByteStreamParameter(bounded)).toBe(true);
        });

        it("should return false for regular ReadableStream", () => {
            const stream = new ReadableStream<Uint8Array>();

            expect(isBoundedByteStreamParameter(stream)).toBe(false);
        });

        it("should return false for non-ReadableStream objects", () => {
            expect(isBoundedByteStreamParameter(null)).toBe(false);
            expect(isBoundedByteStreamParameter(undefined)).toBe(false);
            expect(isBoundedByteStreamParameter({})).toBe(false);
            expect(isBoundedByteStreamParameter({ byteLength: 100 })).toBe(false);
            expect(isBoundedByteStreamParameter([])).toBe(false);
            expect(isBoundedByteStreamParameter("string")).toBe(false);
            expect(isBoundedByteStreamParameter(123)).toBe(false);
        });

        it("should return false for ReadableStream with non-number byteLength", () => {
            const stream = new ReadableStream<Uint8Array>();
            const invalid = Object.assign(stream, { byteLength: "not a number" });

            expect(isBoundedByteStreamParameter(invalid)).toBe(false);
        });
    });
});
