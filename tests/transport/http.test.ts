import { describe, beforeEach, afterEach, it, expect, vi } from "vitest";
import { httpTransport } from "../../src/transport/http";
import { MockHttpServer } from "./http-test-utils";
import { BINARY, TEXT, boundedByteStreamParameter, byteArrayParameter } from "../../src/common/types";


describe("HTTP Transport", () => {
    let mockServer: MockHttpServer;

    beforeEach(() => {
        mockServer = new MockHttpServer();
        mockServer.install();
    });

    afterEach(() => {
        mockServer?.uninstall();
    });

    describe("Basic Functionality", () => {
        it("should execute query with no parameters", async () => {
            mockServer
                .expectQueryDescriptor({ kind: 'query', sql: 'SELECT 1', parameterCount: 0 })
                .respondWithColumns([{ name: 'result', typeOid: 23 }])
                .respondWithRow(['1'])
                .respondWithComplete();

            const transport = httpTransport({
                endpoint: 'http://localhost:3000',
                username: 'test-user',
                password: 'test-pass',
            });

            const result = await transport.statement('query', 'SELECT 1', []);

            expect(result.columns).toHaveLength(1);
            expect(result.columns[0].name).toBe('result');
            expect(result.columns[0].oid).toBe(23);

            const rows = await result.rows.collect();
            expect(rows).toHaveLength(1);
            expect(rows[0]).toEqual(['1']);

            mockServer.verifyAuth('test-user', 'test-pass');
        });

        it("should execute query with multiple rows", async () => {
            mockServer
                .expectQueryDescriptor({ kind: 'query', sql: 'SELECT * FROM users' })
                .respondWithColumns([
                    { name: 'id', typeOid: 23 },
                    { name: 'name', typeOid: 25 }
                ])
                .respondWithRow(['1', 'Alice'])
                .respondWithRow(['2', 'Bob'])
                .respondWithRow(['3', 'Charlie'])
                .respondWithComplete();

            const transport = httpTransport({
                endpoint: 'http://localhost:3000',
                username: 'user',
                password: 'pass',
            });

            const result = await transport.statement('query', 'SELECT * FROM users', []);

            expect(result.columns).toHaveLength(2);

            const rows = await result.rows.collect();
            expect(rows).toHaveLength(3);
            expect(rows[0]).toEqual(['1', 'Alice']);
            expect(rows[1]).toEqual(['2', 'Bob']);
            expect(rows[2]).toEqual(['3', 'Charlie']);
        });

        it("should handle null values in rows", async () => {
            mockServer
                .expectQueryDescriptor({ kind: 'query', sql: 'SELECT * FROM nullable_table' })
                .respondWithColumns([
                    { name: 'id', typeOid: 23 },
                    { name: 'optional_field', typeOid: 25 }
                ])
                .respondWithRow(['1', null])
                .respondWithRow(['2', 'value'])
                .respondWithComplete();

            const transport = httpTransport({
                endpoint: 'http://localhost:3000',
                username: 'user',
                password: 'pass',
            });

            const result = await transport.statement('query', 'SELECT * FROM nullable_table', []);

            const rows = await result.rows.collect();
            expect(rows).toHaveLength(2);
            expect(rows[0]).toEqual(['1', null]);
            expect(rows[1]).toEqual(['2', 'value']);
        });

        it("should execute exec statement kind", async () => {
            mockServer
                .expectQueryDescriptor({ kind: 'exec', sql: 'INSERT INTO users (name) VALUES ($1)' })
                .respondWithColumns([{ name: 'rowsAffected', typeOid: 23 }])
                .respondWithRow(['1'])
                .respondWithComplete();

            const transport = httpTransport({
                endpoint: 'http://localhost:3000',
                username: 'user',
                password: 'pass',
            });

            const result = await transport.statement('exec', 'INSERT INTO users (name) VALUES ($1)', ['Alice']);

            expect(result.columns).toHaveLength(1);
            expect(result.columns[0].name).toBe('rowsAffected');

            const rows = await result.rows.collect();
            expect(rows).toHaveLength(1);
            expect(rows[0]).toEqual(['1']);
        });
    });

    describe("Inline Parameters", () => {
        it("should handle inline text parameters", async () => {
            const shortText = "Hello, World!";

            mockServer
                .expectQueryDescriptor({
                    kind: 'query',
                    sql: 'SELECT $1',
                    parameterCount: 1
                })
                .respondWithColumns([{ name: 'result', typeOid: 25 }])
                .respondWithRow([shortText])
                .respondWithComplete();

            const transport = httpTransport({
                endpoint: 'http://localhost:3000',
                username: 'user',
                password: 'pass',
            });

            const result = await transport.statement('query', 'SELECT $1', [shortText]);

            const rows = await result.rows.collect();
            expect(rows).toHaveLength(1);
            expect(rows[0]).toEqual([shortText]);
        });

        it("should handle inline binary parameters", async () => {
            const smallBinary = byteArrayParameter(new Uint8Array([0, 1, 2, 3, 255]), BINARY);

            mockServer
                .expectQueryDescriptor({
                    kind: 'query',
                    sql: 'SELECT $1',
                    parameterCount: 1
                })
                .respondWithColumns([{ name: 'result', typeOid: 17 }])
                .respondWithRow(['binary_data'])
                .respondWithComplete();

            const transport = httpTransport({
                endpoint: 'http://localhost:3000',
                username: 'user',
                password: 'pass',
            });

            const result = await transport.statement('query', 'SELECT $1', [smallBinary]);

            expect(result.columns).toHaveLength(1);
        });

        it("should handle null parameters", async () => {
            mockServer
                .expectQueryDescriptor({
                    kind: 'query',
                    sql: 'SELECT $1',
                    parameterCount: 1
                })
                .respondWithColumns([{ name: 'result', typeOid: 25 }])
                .respondWithRow([null])
                .respondWithComplete();

            const transport = httpTransport({
                endpoint: 'http://localhost:3000',
                username: 'user',
                password: 'pass',
            });

            const result = await transport.statement('query', 'SELECT $1', [null]);

            const rows = await result.rows.collect();
            expect(rows).toHaveLength(1);
            expect(rows[0]).toEqual([null]);
        });
    });

    describe("Extended Parameters", () => {
        it("should handle extended text parameters", async () => {
            // Create a text parameter larger than 1KB threshold
            const largeText = 'a'.repeat(2000);

            mockServer
                .expectQueryDescriptor({
                    kind: 'query',
                    sql: 'SELECT $1',
                    parameterCount: 1
                })
                .expectTextParam({ byteSize: 2000 })
                .respondWithColumns([{ name: 'result', typeOid: 25 }])
                .respondWithRow(['large_text_result'])
                .respondWithComplete();

            const transport = httpTransport({
                endpoint: 'http://localhost:3000',
                username: 'user',
                password: 'pass',
            });

            const result = await transport.statement('query', 'SELECT $1', [largeText]);

            expect(result.columns).toHaveLength(1);
        });

        it("should handle extended binary parameters", async () => {
            // Create a binary parameter larger than 1KB threshold
            const largeBinary = byteArrayParameter(new Uint8Array(2048), BINARY);
            for (let i = 0; i < largeBinary.length; i++) {
                largeBinary[i] = i % 256;
            }

            mockServer
                .expectQueryDescriptor({
                    kind: 'query',
                    sql: 'SELECT $1',
                    parameterCount: 1
                })
                .expectBinaryParam({ byteSize: 2048 })
                .respondWithColumns([{ name: 'result', typeOid: 17 }])
                .respondWithRow(['binary_result'])
                .respondWithComplete();

            const transport = httpTransport({
                endpoint: 'http://localhost:3000',
                username: 'user',
                password: 'pass',
            });

            const result = await transport.statement('query', 'SELECT $1', [largeBinary]);

            expect(result.columns).toHaveLength(1);
        });

        it("should handle extended text parameters from ByteArrayParameter", async () => {
            // Create a TEXT format ByteArrayParameter larger than 1KB threshold
            const longText = "a".repeat(2000);
            const textData = new TextEncoder().encode(longText);
            const textParam = byteArrayParameter(textData, TEXT);

            mockServer
                .expectQueryDescriptor({
                    kind: 'query',
                    sql: 'SELECT $1',
                    parameterCount: 1
                })
                .expectTextParam({ byteSize: 2000 })
                .respondWithColumns([{ name: 'result', typeOid: 25 }])
                .respondWithRow(['text_result'])
                .respondWithComplete();

            const transport = httpTransport({
                endpoint: 'http://localhost:3000',
                username: 'user',
                password: 'pass',
            });

            const result = await transport.statement('query', 'SELECT $1', [textParam]);

            expect(result.columns).toHaveLength(1);
        });

        it("should handle UTF-8 multi-byte characters in extended parameters", async () => {
            // Create text with multi-byte UTF-8 characters that exceeds 1KB
            const emojiText = '🎉'.repeat(300); // Each emoji is 4 bytes

            mockServer
                .expectQueryDescriptor({
                    kind: 'query',
                    sql: 'SELECT $1',
                    parameterCount: 1
                })
                .expectTextParam({ byteSize: new TextEncoder().encode(emojiText).byteLength })
                .respondWithColumns([{ name: 'result', typeOid: 25 }])
                .respondWithRow([emojiText])
                .respondWithComplete();

            const transport = httpTransport({
                endpoint: 'http://localhost:3000',
                username: 'user',
                password: 'pass',
            });

            const result = await transport.statement('query', 'SELECT $1', [emojiText]);

            expect(result.columns).toHaveLength(1);
        });
    });

    describe("Mixed Parameters", () => {
        it("should handle mix of inline and extended parameters", async () => {
            const shortText = "short";
            const longText = 'x'.repeat(2000);
            const smallBinary = byteArrayParameter(new Uint8Array([1, 2, 3]), BINARY);
            const largeBinary = byteArrayParameter(new Uint8Array(2048), BINARY);

            mockServer
                .expectQueryDescriptor({
                    kind: 'query',
                    sql: 'SELECT $1, $2, $3, $4',
                    parameterCount: 4
                })
                .expectTextParam({ byteSize: 2000 })
                .expectBinaryParam({ byteSize: 2048 })
                .respondWithColumns([
                    { name: 'col1', typeOid: 25 },
                    { name: 'col2', typeOid: 25 },
                    { name: 'col3', typeOid: 17 },
                    { name: 'col4', typeOid: 17 }
                ])
                .respondWithRow(['short', 'long_result', 'small_bin', 'large_bin'])
                .respondWithComplete();

            const transport = httpTransport({
                endpoint: 'http://localhost:3000',
                username: 'user',
                password: 'pass',
            });

            const result = await transport.statement('query', 'SELECT $1, $2, $3, $4', [
                shortText,
                longText,
                smallBinary,
                largeBinary
            ]);

            expect(result.columns).toHaveLength(4);
        });

        it("should handle multiple parameters of same type", async () => {
            mockServer
                .expectQueryDescriptor({
                    kind: 'query',
                    sql: 'SELECT $1, $2, $3',
                    parameterCount: 3
                })
                .respondWithColumns([
                    { name: 'a', typeOid: 25 },
                    { name: 'b', typeOid: 25 },
                    { name: 'c', typeOid: 25 }
                ])
                .respondWithRow(['foo', 'bar', 'baz'])
                .respondWithComplete();

            const transport = httpTransport({
                endpoint: 'http://localhost:3000',
                username: 'user',
                password: 'pass',
            });

            const result = await transport.statement('query', 'SELECT $1, $2, $3', ['foo', 'bar', 'baz']);

            const rows = await result.rows.collect();
            expect(rows).toHaveLength(1);
            expect(rows[0]).toEqual(['foo', 'bar', 'baz']);
        });
    });

    describe("Error Handling", () => {
        it("should handle error responses", async () => {
            mockServer
                .expectQueryDescriptor({ kind: 'query', sql: 'SELECT invalid' })
                .respondWithError({
                    message: 'Syntax error at or near "invalid"',
                    code: '42601'
                });

            const transport = httpTransport({
                endpoint: 'http://localhost:3000',
                username: 'user',
                password: 'pass',
            });

            await expect(
                transport.statement('query', 'SELECT invalid', [])
            ).rejects.toThrow('Syntax error at or near "invalid"');
        });
    });

    describe("Iterator Behavior", () => {
        it("should support async iteration over rows", async () => {
            mockServer
                .expectQueryDescriptor({ kind: 'query', sql: 'SELECT * FROM items' })
                .respondWithColumns([{ name: 'id', typeOid: 23 }])
                .respondWithRow(['1'])
                .respondWithRow(['2'])
                .respondWithRow(['3'])
                .respondWithComplete();

            const transport = httpTransport({
                endpoint: 'http://localhost:3000',
                username: 'user',
                password: 'pass',
            });

            const result = await transport.statement('query', 'SELECT * FROM items', []);

            const collected: (string | null)[][] = [];
            for await (const row of result.rows) {
                collected.push(row);
            }

            expect(collected).toHaveLength(3);
            expect(collected[0]).toEqual(['1']);
            expect(collected[1]).toEqual(['2']);
            expect(collected[2]).toEqual(['3']);
        });

        it("should support collect() method", async () => {
            mockServer
                .expectQueryDescriptor({ kind: 'query', sql: 'SELECT * FROM items' })
                .respondWithColumns([{ name: 'id', typeOid: 23 }])
                .respondWithRow(['1'])
                .respondWithRow(['2'])
                .respondWithComplete();

            const transport = httpTransport({
                endpoint: 'http://localhost:3000',
                username: 'user',
                password: 'pass',
            });

            const result = await transport.statement('query', 'SELECT * FROM items', []);

            const rows = await result.rows.collect();
            expect(rows).toHaveLength(2);
            expect(rows[0]).toEqual(['1']);
            expect(rows[1]).toEqual(['2']);
        });
    });

    describe("Streaming Parameters", () => {
        it("should handle text extended param with BoundedByteStream", async () => {
            // Create a TEXT format BoundedByteStream for text data
            // Make it large enough to exceed the 1KB threshold
            const text = 'hello world '.repeat(100); // ~1200 bytes
            const textData = new TextEncoder().encode(text);

            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(textData);
                    controller.close();
                }
            });

            const textStream = boundedByteStreamParameter(stream, TEXT, textData.byteLength);

            mockServer
                .expectQueryDescriptor({ kind: 'query', sql: 'SELECT $1', parameterCount: 1 })
                .expectTextParam({ byteSize: textData.byteLength })
                .respondWithColumns([{ name: 'result', typeOid: 25 }])
                .respondWithRow(['text_result'])
                .respondWithComplete();

            const transport = httpTransport({
                endpoint: 'http://localhost:3000',
                username: 'user',
                password: 'pass',
            });

            const result = await transport.statement('query', 'SELECT $1', [textStream]);

            expect(result.columns).toHaveLength(1);
        });

        it("should handle text extended param with ReadableStream", async () => {
            // Create a large text that will be sent as ReadableStream
            const largeText = 'streaming'.repeat(200); // Will exceed threshold

            mockServer
                .expectQueryDescriptor({ kind: 'query', sql: 'SELECT $1', parameterCount: 1 })
                .expectTextParam({ byteSize: new TextEncoder().encode(largeText).byteLength })
                .respondWithColumns([{ name: 'result', typeOid: 25 }])
                .respondWithRow(['stream_result'])
                .respondWithComplete();

            const transport = httpTransport({
                endpoint: 'http://localhost:3000',
                username: 'user',
                password: 'pass',
            });

            const result = await transport.statement('query', 'SELECT $1', [largeText]);

            expect(result.columns).toHaveLength(1);
        });

        it("should handle binary extended param with ReadableStream", async () => {
            // Create a BoundedByteStream for binary data
            const data = new Uint8Array(2048);
            for (let i = 0; i < data.length; i++) {
                data[i] = i % 256;
            }

            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(data);
                    controller.close();
                }
            });

            // Create bounded stream
            const boundedStream = boundedByteStreamParameter(stream, BINARY, data.byteLength);

            mockServer
                .expectQueryDescriptor({ kind: 'query', sql: 'SELECT $1', parameterCount: 1 })
                .expectBinaryParam({ byteSize: 2048 })
                .respondWithColumns([{ name: 'result', typeOid: 17 }])
                .respondWithRow(['binary_stream_result'])
                .respondWithComplete();

            const transport = httpTransport({
                endpoint: 'http://localhost:3000',
                username: 'user',
                password: 'pass',
            });

            const result = await transport.statement('query', 'SELECT $1', [boundedStream]);

            expect(result.columns).toHaveLength(1);
        });
    });

    describe("HTTP Error Handling", () => {
        it("should handle HTTP 404 error", async () => {
            // Create a custom mock that returns 404
            const mockFetch = vi.fn(async () => {
                return new Response(null, {
                    status: 404,
                    statusText: 'Not Found'
                });
            });
            global.fetch = mockFetch as any;

            const transport = httpTransport({
                endpoint: 'http://localhost:3000',
                username: 'user',
                password: 'pass',
            });

            await expect(
                transport.statement('query', 'SELECT 1', [])
            ).rejects.toThrow('HTTP error 404: Not Found');
        });

        it("should handle HTTP 500 error", async () => {
            // Create a custom mock that returns 500
            const mockFetch = vi.fn(async () => {
                return new Response(null, {
                    status: 500,
                    statusText: 'Internal Server Error'
                });
            });
            global.fetch = mockFetch as any;

            const transport = httpTransport({
                endpoint: 'http://localhost:3000',
                username: 'user',
                password: 'pass',
            });

            await expect(
                transport.statement('query', 'SELECT 1', [])
            ).rejects.toThrow('HTTP error 500: Internal Server Error');
        });

        it("should handle null response body", async () => {
            // Create a custom mock that returns successful response but null body
            const mockFetch = vi.fn(async () => {
                return new Response(null, {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/x-ndjson',
                    },
                });
            });
            global.fetch = mockFetch as any;

            const transport = httpTransport({
                endpoint: 'http://localhost:3000',
                username: 'user',
                password: 'pass',
            });

            await expect(
                transport.statement('query', 'SELECT 1', [])
            ).rejects.toThrow('Response body is null');
        });
    });

    describe("Configuration", () => {
        it("should include database parameter in URL when provided", async () => {
            mockServer
                .expectQueryDescriptor({ kind: 'query', sql: 'SELECT 1' })
                .respondWithColumns([{ name: 'result', typeOid: 23 }])
                .respondWithRow(['1'])
                .respondWithComplete();

            const transport = httpTransport({
                endpoint: 'http://localhost:3000',
                username: 'user',
                password: 'pass',
                database: 'mydb',
            });

            await transport.statement('query', 'SELECT 1', []);

            const request = mockServer.getReceivedRequest();
            expect(request?.url).toContain('database=mydb');
        });

        it("should not include database parameter when not provided", async () => {
            mockServer
                .expectQueryDescriptor({ kind: 'query', sql: 'SELECT 1' })
                .respondWithColumns([{ name: 'result', typeOid: 23 }])
                .respondWithRow(['1'])
                .respondWithComplete();

            const transport = httpTransport({
                endpoint: 'http://localhost:3000',
                username: 'user',
                password: 'pass',
            });

            await transport.statement('query', 'SELECT 1', []);

            const request = mockServer.getReceivedRequest();
            expect(request?.url).not.toContain('database=');
        });
    });
});
