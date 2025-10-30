import { describe, it, expect, vi } from "vitest";
import { createMultipartStream } from "../../src/transport/multipart";
import { byteArrayParameter, boundedByteStream, BINARY, TEXT } from "../../src/common/types";
import { RequestFrame } from "../../src/transport/frames";

describe("createMultipartStream", () => {
    async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let result = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            result += decoder.decode(value, { stream: true });
        }

        return result;
    }

    describe("Basic Functionality", () => {
        it("should create multipart stream with query descriptor", async () => {
            const frames: RequestFrame[] = [
                { query: "SELECT 1", parameters: [] }
            ];

            const stream = createMultipartStream(frames, "boundary123");
            const result = await streamToString(stream);

            expect(result).toContain("--boundary123\r\n");
            expect(result).toContain('Content-Disposition: form-data; name="urn:prisma:query:descriptor"');
            expect(result).toContain('"query":"SELECT 1"');
            expect(result).toContain("--boundary123--\r\n");
        });

        it("should create multipart stream with exec descriptor", async () => {
            const frames: RequestFrame[] = [
                { exec: "INSERT INTO users (name) VALUES ('test')" }
            ];

            const stream = createMultipartStream(frames, "boundary456");
            const result = await streamToString(stream);

            expect(result).toContain('Content-Disposition: form-data; name="urn:prisma:query:descriptor"');
            expect(result).toContain('"exec":"INSERT INTO users');
        });
    });

    describe("Extended Parameters", () => {
        it("should handle plain string for text parameter", async () => {
            const frames: RequestFrame[] = [
                { query: "SELECT $1", parameters: [{ type: "text", byteSize: 11 }] },
                { type: "text", data: "hello world" }
            ];

            const stream = createMultipartStream(frames, "boundary");
            const result = await streamToString(stream);

            expect(result).toContain('name="urn:prisma:query:param:text"');
            expect(result).toContain("hello world");
        });

        it("should handle plain string for binary parameter", async () => {
            const frames: RequestFrame[] = [
                { query: "SELECT $1", parameters: [{ type: "binary", byteSize: 11 }] },
                { type: "binary", data: "binary data" }
            ];

            const stream = createMultipartStream(frames, "boundary");
            const result = await streamToString(stream);

            expect(result).toContain('name="urn:prisma:query:param:binary"');
            expect(result).toContain("binary data");
        });

        it("should handle text ByteArrayParameter", async () => {
            const textData = new TextEncoder().encode("hello world");
            const param = byteArrayParameter(textData, TEXT);

            const frames: RequestFrame[] = [
                { query: "SELECT $1", parameters: [{ type: "text", byteSize: textData.byteLength }] },
                { type: "text", data: param }
            ];

            const stream = createMultipartStream(frames, "boundary");
            const result = await streamToString(stream);

            expect(result).toContain('name="urn:prisma:query:param:text"');
            expect(result).toContain("hello world");
        });

        it("should handle binary ByteArrayParameter", async () => {
            const binaryData = new Uint8Array([1, 2, 3, 4, 5]);
            const param = byteArrayParameter(binaryData, BINARY);

            const frames: RequestFrame[] = [
                { query: "SELECT $1", parameters: [{ type: "binary", byteSize: binaryData.byteLength }] },
                { type: "binary", data: param }
            ];

            const stream = createMultipartStream(frames, "boundary");
            const result = await streamToString(stream);

            expect(result).toContain('name="urn:prisma:query:param:binary"');
            expect(result).toContain('Content-Type: application/octet-stream');
        });

        it("should handle text BoundedByteStream", async () => {
            const text = "streaming text data";
            const textData = new TextEncoder().encode(text);

            const readableStream = new ReadableStream({
                start(controller) {
                    controller.enqueue(textData);
                    controller.close();
                }
            });

            const stream = boundedByteStream(readableStream, TEXT, textData.byteLength);

            const frames: RequestFrame[] = [
                { query: "SELECT $1", parameters: [{ type: "text", byteSize: textData.byteLength }] },
                { type: "text", data: stream }
            ];

            const multipartStream = createMultipartStream(frames, "boundary");
            const result = await streamToString(multipartStream);

            expect(result).toContain('name="urn:prisma:query:param:text"');
            expect(result).toContain(text);
        });

        it("should handle binary BoundedByteStream", async () => {
            const binaryData = new Uint8Array([10, 20, 30]);

            const readableStream = new ReadableStream({
                start(controller) {
                    controller.enqueue(binaryData);
                    controller.close();
                }
            });

            const stream = boundedByteStream(readableStream, BINARY, binaryData.byteLength);

            const frames: RequestFrame[] = [
                { query: "SELECT $1", parameters: [{ type: "binary", byteSize: binaryData.byteLength }] },
                { type: "binary", data: stream }
            ];

            const multipartStream = createMultipartStream(frames, "boundary");
            const result = await streamToString(multipartStream);

            expect(result).toContain('name="urn:prisma:query:param:binary"');
        });
    });

    describe("Error Handling", () => {
        it("should throw error for invalid frame type", async () => {
            // Create a frame with an invalid type
            const frames: RequestFrame[] = [
                { invalid: "frame" } as any
            ];

            const stream = createMultipartStream(frames, "boundary");
            const reader = stream.getReader();

            await expect(async () => {
                while (true) {
                    const { done } = await reader.read();
                    if (done) break;
                }
            }).rejects.toThrow("Unsupported frame type");
        });

        it("should throw error for unsupported text parameter type", async () => {
            // Create a frame with an invalid data type (plain Uint8Array without format)
            const frames: RequestFrame[] = [
                { query: "SELECT $1", parameters: [{ type: "text", byteSize: 10 }] },
                { type: "text", data: new Uint8Array([1, 2, 3]) as any }
            ];

            const stream = createMultipartStream(frames, "boundary");
            const reader = stream.getReader();

            await expect(async () => {
                while (true) {
                    const { done } = await reader.read();
                    if (done) break;
                }
            }).rejects.toThrow("Unsupported text extended parameter data type");
        });

        it("should throw error for unsupported binary parameter type", async () => {
            // Create a frame with an invalid data type (plain ReadableStream without format)
            const plainStream = new ReadableStream({
                start(controller) {
                    controller.enqueue(new Uint8Array([1, 2, 3]));
                    controller.close();
                }
            });

            const frames: RequestFrame[] = [
                { query: "SELECT $1", parameters: [{ type: "binary", byteSize: 3 }] },
                { type: "binary", data: plainStream as any }
            ];

            const stream = createMultipartStream(frames, "boundary");
            const reader = stream.getReader();

            await expect(async () => {
                while (true) {
                    const { done } = await reader.read();
                    if (done) break;
                }
            }).rejects.toThrow("Unsupported binary extended parameter data type");
        });

        it("should handle errors in generator", async () => {
            // Create a stream that will throw an error
            const errorStream = new ReadableStream({
                start(controller) {
                    controller.error(new Error("Stream error"));
                }
            });

            const stream = boundedByteStream(errorStream, TEXT, 10);

            const frames: RequestFrame[] = [
                { query: "SELECT $1", parameters: [{ type: "text", byteSize: 10 }] },
                { type: "text", data: stream }
            ];

            const multipartStream = createMultipartStream(frames, "boundary");
            const reader = multipartStream.getReader();

            // Should propagate the error
            await expect(async () => {
                while (true) {
                    const { done } = await reader.read();
                    if (done) break;
                }
            }).rejects.toThrow("Stream error");
        });

        it("should handle stream cancellation", async () => {
            const textData = new TextEncoder().encode("test data");

            const readableStream = new ReadableStream({
                start(controller) {
                    controller.enqueue(textData);
                    // Don't close immediately, so cancellation can happen
                },
            });

            const stream = boundedByteStream(readableStream, TEXT, textData.byteLength);

            const frames: RequestFrame[] = [
                { query: "SELECT $1", parameters: [{ type: "text", byteSize: textData.byteLength }] },
                { type: "text", data: stream }
            ];

            const multipartStream = createMultipartStream(frames, "boundary");
            const reader = multipartStream.getReader();

            // Cancel the stream without reading all chunks
            await reader.cancel("User cancelled");

            // Verify the stream is cancelled - further reads should indicate done
            const result = await reader.read();
            expect(result.done).toBe(true);
        });
    });

    describe("Multiple Parameters", () => {
        it("should handle multiple extended parameters", async () => {
            const text1 = new TextEncoder().encode("param1");
            const text2 = new TextEncoder().encode("param2");
            const binary = new Uint8Array([1, 2, 3]);

            const param1 = byteArrayParameter(text1, TEXT);
            const param2 = byteArrayParameter(text2, TEXT);
            const param3 = byteArrayParameter(binary, BINARY);

            const frames: RequestFrame[] = [
                {
                    query: "SELECT $1, $2, $3",
                    parameters: [
                        { type: "text", byteSize: text1.byteLength },
                        { type: "text", byteSize: text2.byteLength },
                        { type: "binary", byteSize: binary.byteLength }
                    ]
                },
                { type: "text", data: param1 },
                { type: "text", data: param2 },
                { type: "binary", data: param3 }
            ];

            const stream = createMultipartStream(frames, "boundary");
            const result = await streamToString(stream);

            // Should have query descriptor + 3 params + closing boundary
            const boundaryCount = (result.match(/--boundary/g) || []).length;
            expect(boundaryCount).toBe(5); // 4 opening + 1 closing

            expect(result).toContain("param1");
            expect(result).toContain("param2");
        });
    });

    describe("Streaming Behavior", () => {
        it("should handle chunked streaming", async () => {
            const chunk1 = new TextEncoder().encode("chunk1");
            const chunk2 = new TextEncoder().encode("chunk2");
            const chunk3 = new TextEncoder().encode("chunk3");

            const readableStream = new ReadableStream({
                async start(controller) {
                    controller.enqueue(chunk1);
                    controller.enqueue(chunk2);
                    controller.enqueue(chunk3);
                    controller.close();
                }
            });

            const totalLength = chunk1.byteLength + chunk2.byteLength + chunk3.byteLength;
            const stream = boundedByteStream(readableStream, TEXT, totalLength);

            const frames: RequestFrame[] = [
                { query: "SELECT $1", parameters: [{ type: "text", byteSize: totalLength }] },
                { type: "text", data: stream }
            ];

            const multipartStream = createMultipartStream(frames, "boundary");
            const result = await streamToString(multipartStream);

            expect(result).toContain("chunk1chunk2chunk3");
        });
    });
});
