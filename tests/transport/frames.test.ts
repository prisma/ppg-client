import { describe, it, expect } from "vitest";
import { requestFrames, QueryDescriptorFrame, ExtendedParamFrame } from "../../src/transport/frames";
import { boundedByteStream, byteArrayParameter, BINARY, TEXT } from "../../src/common/types";

describe("queryRequest", () => {
    describe("string parameters", () => {
        it("should inline short strings", async () => {
            const frames = await requestFrames("query", "SELECT $1", ["hello"]);

            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame & { query: string };
            expect(descriptor.query).toBe("SELECT $1");
            expect(descriptor.parameters).toHaveLength(1);
            expect(descriptor.parameters![0]).toEqual({
                type: "text",
                value: "hello",
            });
        });

        it("should create extended param for long strings (>1024 bytes)", async () => {
            const longString = "a".repeat(1025);
            const frames = await requestFrames("query", "SELECT $1", [longString]);

            expect(frames).toHaveLength(2);

            const descriptor = frames[0] as QueryDescriptorFrame & { query: string };
            expect(descriptor.query).toBe("SELECT $1");
            expect(descriptor.parameters).toHaveLength(1);
            expect(descriptor.parameters![0]).toEqual({
                type: "text",
                byteSize: 1025,
            });

            const extendedParam = frames[1] as ExtendedParamFrame;
            expect(extendedParam.type).toBe("text");
            expect(extendedParam.data).toBeInstanceOf(ReadableStream);

            // Verify the stream content
            const reader = (extendedParam.data as ReadableStream<Uint8Array>).getReader();
            const chunks: Uint8Array[] = [];
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
            }
            const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
            expect(totalLength).toBe(1025);
        });

        it("should handle multi-byte UTF-8 characters correctly", async () => {
            const unicodeString = "🎉".repeat(300); // Each emoji is 4 bytes
            const frames = await requestFrames("query", "SELECT $1", [unicodeString]);

            expect(frames).toHaveLength(2);

            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters![0]).toHaveProperty("byteSize", 1200);
        });
    });

    describe("binary parameters (ByteArrayParameter)", () => {
        it("should inline small binary data (<= 1KB)", async () => {
            const smallBinary = byteArrayParameter(new Uint8Array([1, 2, 3, 4, 5]), BINARY);
            const frames = await requestFrames("query", "SELECT $1", [smallBinary]);

            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters).toHaveLength(1);
            expect(descriptor.parameters![0]).toEqual({
                type: "binary",
                value: "AQIDBAU=", // base64 of [1,2,3,4,5]
            });
        });

        it("should create extended param for large binary data (> 1KB)", async () => {
            const array = new Uint8Array(1025);
            for (let i = 0; i < array.length; i++) {
                array[i] = i % 256;
            }
            const largeBinary = byteArrayParameter(array, BINARY);

            const frames = await requestFrames("query", "SELECT $1", [largeBinary]);

            expect(frames).toHaveLength(2);

            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters![0]).toEqual({
                type: "binary",
                byteSize: 1025,
            });

            const extendedParam = frames[1] as ExtendedParamFrame;
            expect(extendedParam.type).toBe("binary");
            expect(extendedParam.data).toBe(largeBinary);
        });

        it("should handle binary data with all byte values", async () => {
            // Test all byte values including non-printable characters
            const array = new Uint8Array(256);
            for (let i = 0; i < 256; i++) {
                array[i] = i;
            }
            const allBytes = byteArrayParameter(array, BINARY);

            const frames = await requestFrames("query", "SELECT $1", [allBytes]);

            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters![0]).toHaveProperty("type", "binary");
            expect(descriptor.parameters![0]).toHaveProperty("value");

            // Verify we can decode it back
            const base64 = (descriptor.parameters![0] as any).value;
            expect(typeof base64).toBe("string");
        });

        it("should handle text format ByteArrayParameter inline", async () => {
            const textData = new TextEncoder().encode("hello world");
            const textParam = byteArrayParameter(textData, TEXT);
            const frames = await requestFrames("query", "SELECT $1", [textParam]);

            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters![0]).toEqual({
                type: "text",
                value: "hello world",
            });
        });

        it("should handle text format ByteArrayParameter extended", async () => {
            const longText = "a".repeat(1500);
            const textData = new TextEncoder().encode(longText);
            const textParam = byteArrayParameter(textData, TEXT);
            const frames = await requestFrames("query", "SELECT $1", [textParam]);

            expect(frames).toHaveLength(2);
            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters![0]).toEqual({
                type: "text",
                byteSize: 1500,
            });

            const extendedParam = frames[1] as ExtendedParamFrame;
            expect(extendedParam.type).toBe("text");
            expect(extendedParam.data).toBe(textParam);
        });
    });

    describe("bounded stream parameters", () => {
        it("should inline small binary bounded streams (<= 1KB)", async () => {
            const data = new Uint8Array([10, 20, 30, 40]);
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(data);
                    controller.close();
                }
            });
            const boundedStream = boundedByteStream(stream, BINARY, data.byteLength);

            const frames = await requestFrames("query", "SELECT $1", [boundedStream]);

            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters![0]).toEqual({
                type: "binary",
                value: "ChQeKA==", // base64 of [10,20,30,40]
            });
        });

        it("should inline small text bounded streams (<= 1KB)", async () => {
            const text = "hello world";
            const data = new TextEncoder().encode(text);
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(data);
                    controller.close();
                }
            });
            const boundedStream = boundedByteStream(stream, TEXT, data.byteLength);

            const frames = await requestFrames("query", "SELECT $1", [boundedStream]);

            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters![0]).toEqual({
                type: "text",
                value: "hello world",
            });
        });

        it("should create extended param for large binary bounded streams (> 1KB)", async () => {
            const largeData = new Uint8Array(2048);
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(largeData);
                    controller.close();
                }
            });
            const boundedStream = boundedByteStream(stream, BINARY, largeData.byteLength);

            const frames = await requestFrames("query", "SELECT $1", [boundedStream]);

            expect(frames).toHaveLength(2);

            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters![0]).toEqual({
                type: "binary",
                byteSize: 2048,
            });

            const extendedParam = frames[1] as ExtendedParamFrame;
            expect(extendedParam.type).toBe("binary");
            expect(extendedParam.data).toBe(boundedStream);
        });

        it("should create extended param for large text bounded streams (> 1KB)", async () => {
            const longText = "x".repeat(2048);
            const data = new TextEncoder().encode(longText);
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(data);
                    controller.close();
                }
            });
            const boundedStream = boundedByteStream(stream, TEXT, data.byteLength);

            const frames = await requestFrames("query", "SELECT $1", [boundedStream]);

            expect(frames).toHaveLength(2);

            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters![0]).toEqual({
                type: "text",
                byteSize: 2048,
            });

            const extendedParam = frames[1] as ExtendedParamFrame;
            expect(extendedParam.type).toBe("text");
            expect(extendedParam.data).toBe(boundedStream);
        });

        it("should handle binary bounded streams with multiple chunks", async () => {
            const chunk1 = new Uint8Array([1, 2, 3]);
            const chunk2 = new Uint8Array([4, 5, 6]);
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(chunk1);
                    controller.enqueue(chunk2);
                    controller.close();
                }
            });
            const boundedStream = boundedByteStream(stream, BINARY, 6);

            const frames = await requestFrames("query", "SELECT $1", [boundedStream]);

            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters![0]).toEqual({
                type: "binary",
                value: "AQIDBAUG", // base64 of [1,2,3,4,5,6]
            });
        });

        it("should handle text bounded streams with multiple chunks", async () => {
            const text1 = "hello ";
            const text2 = "world";
            const chunk1 = new TextEncoder().encode(text1);
            const chunk2 = new TextEncoder().encode(text2);
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(chunk1);
                    controller.enqueue(chunk2);
                    controller.close();
                }
            });
            const boundedStream = boundedByteStream(stream, TEXT, chunk1.byteLength + chunk2.byteLength);

            const frames = await requestFrames("query", "SELECT $1", [boundedStream]);

            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters![0]).toEqual({
                type: "text",
                value: "hello world",
            });
        });
    });

    describe("null parameters", () => {
        it("should handle null values", async () => {
            const frames = await requestFrames("query", "SELECT $1", [null]);

            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters![0]).toEqual({
                type: "text",
                value: null,
            });
        });
    });

    describe("multiple parameters", () => {
        it("should handle mixed parameter types", async () => {
            const shortString = "hello";
            const binary = byteArrayParameter(new Uint8Array([1, 2, 3]), BINARY);
            const longString = "x".repeat(1500);

            const frames = await requestFrames("query",
                "SELECT $1, $2, $3",
                [shortString, binary, longString]
            );

            expect(frames).toHaveLength(2);

            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters).toHaveLength(3);
            expect(descriptor.parameters![0]).toHaveProperty("value", "hello");
            expect(descriptor.parameters![1]).toHaveProperty("value", "AQID");
            expect(descriptor.parameters![2]).toHaveProperty("byteSize", 1500);

            const extendedParam = frames[1] as ExtendedParamFrame;
            expect(extendedParam.type).toBe("text");
        });

        it("should handle multiple extended parameters", async () => {
            const long1 = "a".repeat(1500);
            const long2 = "b".repeat(2000);
            const largeBinary = byteArrayParameter(new Uint8Array(1500), BINARY);

            const frames = await requestFrames("query",
                "SELECT $1, $2, $3",
                [long1, long2, largeBinary]
            );

            expect(frames).toHaveLength(4); // 1 descriptor + 3 extended params

            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters).toHaveLength(3);
            expect(descriptor.parameters![0]).toEqual({ type: "text", byteSize: 1500 });
            expect(descriptor.parameters![1]).toEqual({ type: "text", byteSize: 2000 });
            expect(descriptor.parameters![2]).toEqual({ type: "binary", byteSize: 1500 });

            expect(frames[1]).toHaveProperty("type", "text");
            expect(frames[2]).toHaveProperty("type", "text");
            expect(frames[3]).toHaveProperty("type", "binary");
        });
    });

    describe("no parameters", () => {
        it("should handle query with no parameters", async () => {
            const frames = await requestFrames("query", "SELECT * FROM users", []);

            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame & { query: string };
            expect(descriptor.query).toBe("SELECT * FROM users");
            expect(descriptor.parameters).toBeUndefined();
        });
    });

    describe("error handling", () => {
        it("should throw error for unsupported parameter types", async () => {
            // Test with number
            await expect(
                requestFrames("query", "SELECT $1", [123 as any])
            ).rejects.toThrow("unsupported raw parameter type");

            // Test with boolean
            await expect(
                requestFrames("query", "SELECT $1", [true as any])
            ).rejects.toThrow("unsupported raw parameter type");

            // Test with object
            await expect(
                requestFrames("query", "SELECT $1", [{ key: "value" } as any])
            ).rejects.toThrow("unsupported raw parameter type");

            // Test with array
            await expect(
                requestFrames("query", "SELECT $1", [[1, 2, 3] as any])
            ).rejects.toThrow("unsupported raw parameter type");
        });
    });

    describe("edge cases", () => {
        it("should handle exactly 1024 byte string (boundary)", async () => {
            const string1024 = "a".repeat(1024);
            const frames = await requestFrames("query", "SELECT $1", [string1024]);

            // Should be inline since it's <= 1024
            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters![0]).toHaveProperty("value");
        });

        it("should handle exactly 1024 byte binary (boundary)", async () => {
            const binary1024 = byteArrayParameter(new Uint8Array(1024), BINARY);
            const frames = await requestFrames("query", "SELECT $1", [binary1024]);

            // Should be inline since it's <= 1024
            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters![0]).toHaveProperty("value");
        });

        it("should handle empty string", async () => {
            const frames = await requestFrames("query", "SELECT $1", [""]);

            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters![0]).toEqual({
                type: "text",
                value: "",
            });
        });

        it("should handle empty binary array", async () => {
            const emptyBinary = byteArrayParameter(new Uint8Array(0), BINARY);
            const frames = await requestFrames("query", "SELECT $1", [emptyBinary]);

            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters![0]).toEqual({
                type: "binary",
                value: "",
            });
        });
    });

    describe("exec kind", () => {
        it("should create exec frame for INSERT statements", async () => {
            const frames = await requestFrames("exec", "INSERT INTO users (name, email) VALUES ($1, $2)", ["John Doe", "john@example.com"]);

            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame;

            // Verify it has exec property, not query
            expect(descriptor).toHaveProperty("exec", "INSERT INTO users (name, email) VALUES ($1, $2)");
            expect(descriptor).not.toHaveProperty("query");

            expect(descriptor.parameters).toHaveLength(2);
            expect(descriptor.parameters![0]).toEqual({
                type: "text",
                value: "John Doe",
            });
            expect(descriptor.parameters![1]).toEqual({
                type: "text",
                value: "john@example.com",
            });
        });

        it("should create exec frame for UPDATE statements", async () => {
            const frames = await requestFrames("exec", "UPDATE users SET name = $1 WHERE id = $2", ["Jane Doe", "123"]);

            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame;

            expect(descriptor).toHaveProperty("exec", "UPDATE users SET name = $1 WHERE id = $2");
            expect(descriptor).not.toHaveProperty("query");
            expect(descriptor.parameters).toHaveLength(2);
        });

        it("should create exec frame for DELETE statements", async () => {
            const frames = await requestFrames("exec", "DELETE FROM users WHERE id = $1", ["456"]);

            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame;

            expect(descriptor).toHaveProperty("exec", "DELETE FROM users WHERE id = $1");
            expect(descriptor).not.toHaveProperty("query");
            expect(descriptor.parameters).toHaveLength(1);
        });

        it("should handle exec with large parameters", async () => {
            const largeText = "x".repeat(2000);
            const frames = await requestFrames("exec", "INSERT INTO documents (content) VALUES ($1)", [largeText]);

            expect(frames).toHaveLength(2);

            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor).toHaveProperty("exec");
            expect(descriptor.parameters![0]).toEqual({
                type: "text",
                byteSize: 2000,
            });

            const extendedParam = frames[1] as ExtendedParamFrame;
            expect(extendedParam.type).toBe("text");
        });
    });
});
