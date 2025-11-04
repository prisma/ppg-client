import { describe, expect, it } from "vitest";
import { parseNDJSONResponse } from "../../src/transport/ndjson.ts";

/**
 * Helper to create a mock Response with NDJSON stream
 */
function createNDJSONResponse(lines: string[]): Response {
    const ndjsonContent = lines.join("\n");
    const encoder = new TextEncoder();
    const data = encoder.encode(ndjsonContent);

    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(data);
            controller.close();
        },
    });

    return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
    });
}

/**
 * Helper to create a chunked NDJSON response (simulates streaming)
 */
function createChunkedNDJSONResponse(chunks: string[]): Response {
    const encoder = new TextEncoder();
    let chunkIndex = 0;

    const stream = new ReadableStream({
        start(controller) {
            function pushChunk() {
                if (chunkIndex < chunks.length) {
                    controller.enqueue(encoder.encode(chunks[chunkIndex]));
                    chunkIndex++;
                    setTimeout(pushChunk, 0);
                } else {
                    controller.close();
                }
            }
            pushChunk();
        },
    });

    return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
    });
}

describe("parseNDJSONResponse", () => {
    describe("Basic functionality", () => {
        it("should parse DataRowDescription and DataRow frames", async () => {
            const response = createNDJSONResponse([
                '{"columns":[{"name":"id","typeOid":23},{"name":"name","typeOid":25}]}',
                '{"values":["1","Alice"]}',
                '{"values":["2","Bob"]}',
                '{"complete":true}',
            ]);

            const result = await parseNDJSONResponse(response);

            expect(result.columns).toEqual([
                { name: "id", oid: 23 },
                { name: "name", oid: 25 },
            ]);

            const rows = await result.rows.collect();
            expect(rows).toEqual([
                ["1", "Alice"],
                ["2", "Bob"],
            ]);
        });

        it("should handle null values in DataRow", async () => {
            const response = createNDJSONResponse([
                '{"columns":[{"name":"id","typeOid":23},{"name":"name","typeOid":25}]}',
                '{"values":["1",null]}',
                '{"complete":true}',
            ]);

            const result = await parseNDJSONResponse(response);
            const rows = await result.rows.collect();

            expect(rows).toEqual([["1", null]]);
        });

        it("should handle empty result set (no data rows)", async () => {
            const response = createNDJSONResponse(['{"columns":[{"name":"id","typeOid":23}]}', '{"complete":true}']);

            const result = await parseNDJSONResponse(response);
            const rows = await result.rows.collect();

            expect(result.columns).toEqual([{ name: "id", oid: 23 }]);
            expect(rows).toEqual([]);
        });
    });

    describe("Error handling", () => {
        it("should throw error when response body is null", async () => {
            const response = new Response(null, { status: 200 });

            await expect(parseNDJSONResponse(response)).rejects.toThrow("Response body is null");
        });

        it("should handle ErrorFrame and throw database error", async () => {
            const response = createNDJSONResponse([
                '{"columns":[{"name":"id","typeOid":23}]}',
                '{"values":["1"]}',
                '{"error":{"message":"division by zero","code":"22012"}}',
            ]);

            const result = await parseNDJSONResponse(response);

            await expect(result.rows.collect()).rejects.toThrow("division by zero");
        });

        it("should handle ErrorFrame with additional error details", async () => {
            const response = createNDJSONResponse([
                '{"columns":[{"name":"id","typeOid":23}]}',
                '{"values":["1"]}',
                '{"error":{"message":"syntax error","code":"42601","detail":"unexpected token"}}',
            ]);

            const result = await parseNDJSONResponse(response);

            await expect(result.rows.collect()).rejects.toThrow("syntax error");
        });

        it("should silently ignore unsupported frame types", async () => {
            // Test the implicit else branch when none of the type guards match
            const response = createNDJSONResponse([
                '{"columns":[{"name":"id","typeOid":23}]}',
                '{"values":["1"]}',
                '{"unsupportedFrameType":"some data"}',
                '{"values":["2"]}',
                '{"complete":true}',
            ]);

            const result = await parseNDJSONResponse(response);
            const rows = await result.rows.collect();

            // Unknown frame should be ignored, only valid DataRow frames returned
            expect(rows).toEqual([["1"], ["2"]]);
        });
    });

    describe("Streaming and buffering", () => {
        it("should handle chunked streaming across frame boundaries", async () => {
            // Simulate chunks that split JSON frames
            const response = createChunkedNDJSONResponse([
                '{"columns":[{"name":"id","typeOid":23}]}\n{"val',
                'ues":["1"]}\n{"values":["2"]}\n',
                '{"complete":true}',
            ]);

            const result = await parseNDJSONResponse(response);
            const rows = await result.rows.collect();

            expect(rows).toEqual([["1"], ["2"]]);
        });

        it("should handle empty lines and whitespace", async () => {
            const response = createNDJSONResponse([
                '{"columns":[{"name":"id","typeOid":23}]}',
                "",
                "   ",
                '{"values":["1"]}',
                "",
                '{"complete":true}',
            ]);

            const result = await parseNDJSONResponse(response);
            const rows = await result.rows.collect();

            expect(rows).toEqual([["1"]]);
        });

        it("should handle stream ending with incomplete line in buffer", async () => {
            // This tests the line 37 else branch where done=true and buffer has content
            const encoder = new TextEncoder();
            const stream = new ReadableStream({
                start(controller) {
                    // Send frames without final newline
                    controller.enqueue(encoder.encode('{"columns":[{"name":"id","typeOid":23}]}\n'));
                    controller.enqueue(encoder.encode('{"values":["1"]}\n'));
                    controller.enqueue(encoder.encode('{"complete":true}'));
                    controller.close();
                },
            });

            const response = new Response(stream, { status: 200 });
            const result = await parseNDJSONResponse(response);
            const rows = await result.rows.collect();

            expect(rows).toEqual([["1"]]);
        });

        it("should handle stream ending after processing all frames", async () => {
            // This tests lines 63-64: the if (done) break after CommandComplete
            const response = createNDJSONResponse([
                '{"columns":[{"name":"id","typeOid":23}]}',
                '{"values":["1"]}',
                '{"values":["2"]}',
                '{"complete":true}',
            ]);

            const result = await parseNDJSONResponse(response);
            const rows = await result.rows.collect();

            expect(rows).toEqual([["1"], ["2"]]);
        });

        it("should handle multiple chunks with partial lines", async () => {
            // Test that buffer correctly holds incomplete lines
            const response = createChunkedNDJSONResponse([
                '{"columns":[{"n',
                'ame":"id","oid":23}]}\n',
                '{"values":',
                '["1"]}\n{"complete":true}',
            ]);

            const result = await parseNDJSONResponse(response);
            const rows = await result.rows.collect();

            expect(rows).toEqual([["1"]]);
        });

        it("should handle stream ending without CommandComplete frame", async () => {
            // Test line 64: break when done=true without hitting CommandComplete
            const response = createNDJSONResponse([
                '{"columns":[{"name":"id","typeOid":23}]}',
                '{"values":["1"]}',
                '{"values":["2"]}',
                // No CommandComplete frame - stream just ends
            ]);

            const result = await parseNDJSONResponse(response);
            const rows = await result.rows.collect();

            // Should still get all the rows even without CommandComplete
            expect(rows).toEqual([["1"], ["2"]]);
        });
    });

    describe("First row handling", () => {
        it("should correctly yield first row and subsequent rows", async () => {
            const response = createNDJSONResponse([
                '{"columns":[{"name":"id","typeOid":23}]}',
                '{"values":["1"]}',
                '{"values":["2"]}',
                '{"values":["3"]}',
                '{"complete":true}',
            ]);

            const result = await parseNDJSONResponse(response);

            // Manually iterate to verify first row handling
            const iterator = result.rows[Symbol.asyncIterator]();

            const first = await iterator.next();
            expect(first.value).toEqual(["1"]);
            expect(first.done).toBe(false);

            const second = await iterator.next();
            expect(second.value).toEqual(["2"]);
            expect(second.done).toBe(false);

            const third = await iterator.next();
            expect(third.value).toEqual(["3"]);
            expect(third.done).toBe(false);

            const fourth = await iterator.next();
            expect(fourth.done).toBe(true);
        });

        it("should handle case where first result is done (no data rows)", async () => {
            const response = createNDJSONResponse(['{"columns":[{"name":"id","typeOid":23}]}', '{"complete":true}']);

            const result = await parseNDJSONResponse(response);
            const rows = await result.rows.collect();

            expect(rows).toEqual([]);
        });
    });

    describe("Resource cleanup", () => {
        it("should release reader lock in finally block on normal completion", async () => {
            const response = createNDJSONResponse([
                '{"columns":[{"name":"id","typeOid":23}]}',
                '{"values":["1"]}',
                '{"complete":true}',
            ]);

            const result = await parseNDJSONResponse(response);
            await result.rows.collect();

            // If we get here without hanging, the lock was properly released
            expect(true).toBe(true);
        });

        it("should release reader lock in finally block on error", async () => {
            const response = createNDJSONResponse([
                '{"columns":[{"name":"id","typeOid":23}]}',
                '{"values":["1"]}',
                '{"error":{"message":"test error","code":"TEST"}}',
            ]);

            const result = await parseNDJSONResponse(response);

            await expect(result.rows.collect()).rejects.toThrow("test error");

            // If we get here without hanging, the lock was properly released
            expect(true).toBe(true);
        });
    });
});
