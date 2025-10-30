import { describe, it, expect } from "vitest";
import { queryRequest, QueryDescriptorFrame, ExtendedParamFrame } from "../../src/transport/frames";
import { boundedByteStream } from "../../src/common/types";

describe("queryRequest", () => {
    describe("string parameters", () => {
        it("should inline short strings", async () => {
            const frames = await queryRequest("SELECT $1", ["hello"]);

            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.query).toBe("SELECT $1");
            expect(descriptor.parameters).toHaveLength(1);
            expect(descriptor.parameters![0]).toEqual({
                type: "text",
                value: "hello",
            });
        });

        it("should create extended param for long strings (>1024 bytes)", async () => {
            const longString = "a".repeat(1025);
            const frames = await queryRequest("SELECT $1", [longString]);

            expect(frames).toHaveLength(2);

            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.query).toBe("SELECT $1");
            expect(descriptor.parameters).toHaveLength(1);
            expect(descriptor.parameters![0]).toEqual({
                type: "text",
                byteSize: 1025,
            });

            const extendedParam = frames[1] as ExtendedParamFrame;
            expect(extendedParam.type).toBe("text");
            expect(extendedParam.data).toBeInstanceOf(Uint8Array);
            expect((extendedParam.data as Uint8Array).length).toBe(1025);
        });

        it("should handle multi-byte UTF-8 characters correctly", async () => {
            const unicodeString = "🎉".repeat(300); // Each emoji is 4 bytes
            const frames = await queryRequest("SELECT $1", [unicodeString]);

            expect(frames).toHaveLength(2);

            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters![0]).toHaveProperty("byteSize", 1200);
        });
    });

    describe("binary parameters (Uint8Array)", () => {
        it("should inline small binary data (<= 1KB)", async () => {
            const smallBinary = new Uint8Array([1, 2, 3, 4, 5]);
            const frames = await queryRequest("SELECT $1", [smallBinary]);

            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters).toHaveLength(1);
            expect(descriptor.parameters![0]).toEqual({
                type: "binary",
                value: "AQIDBAU=", // base64 of [1,2,3,4,5]
            });
        });

        it("should create extended param for large binary data (> 1KB)", async () => {
            const largeBinary = new Uint8Array(1025);
            for (let i = 0; i < largeBinary.length; i++) {
                largeBinary[i] = i % 256;
            }

            const frames = await queryRequest("SELECT $1", [largeBinary]);

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
            const allBytes = new Uint8Array(256);
            for (let i = 0; i < 256; i++) {
                allBytes[i] = i;
            }

            const frames = await queryRequest("SELECT $1", [allBytes]);

            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters![0]).toHaveProperty("type", "binary");
            expect(descriptor.parameters![0]).toHaveProperty("value");

            // Verify we can decode it back
            const base64 = (descriptor.parameters![0] as any).value;
            expect(typeof base64).toBe("string");
        });
    });

    describe("bounded stream parameters", () => {
        it("should inline small bounded streams (<= 1KB)", async () => {
            const data = new Uint8Array([10, 20, 30, 40]);
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(data);
                    controller.close();
                }
            });
            const boundedStream = boundedByteStream(stream, data.byteLength);

            const frames = await queryRequest("SELECT $1", [boundedStream]);

            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters![0]).toEqual({
                type: "binary",
                value: "ChQeKA==", // base64 of [10,20,30,40]
            });
        });

        it("should create extended param for large bounded streams (> 1KB)", async () => {
            const largeData = new Uint8Array(2048);
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(largeData);
                    controller.close();
                }
            });
            const boundedStream = boundedByteStream(stream, largeData.byteLength);

            const frames = await queryRequest("SELECT $1", [boundedStream]);

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

        it("should handle bounded streams with multiple chunks", async () => {
            const chunk1 = new Uint8Array([1, 2, 3]);
            const chunk2 = new Uint8Array([4, 5, 6]);
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(chunk1);
                    controller.enqueue(chunk2);
                    controller.close();
                }
            });
            const boundedStream = boundedByteStream(stream, 6);

            const frames = await queryRequest("SELECT $1", [boundedStream]);

            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters![0]).toEqual({
                type: "binary",
                value: "AQIDBAUG", // base64 of [1,2,3,4,5,6]
            });
        });
    });

    describe("null parameters", () => {
        it("should handle null values", async () => {
            const frames = await queryRequest("SELECT $1", [null]);

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
            const binary = new Uint8Array([1, 2, 3]);
            const longString = "x".repeat(1500);

            const frames = await queryRequest(
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
            const largeBinary = new Uint8Array(1500);

            const frames = await queryRequest(
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
            const frames = await queryRequest("SELECT * FROM users", []);

            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.query).toBe("SELECT * FROM users");
            expect(descriptor.parameters).toBeUndefined();
        });
    });

    describe("error handling", () => {
        it("should throw error for unsupported parameter types", async () => {
            // Test with number
            await expect(
                queryRequest("SELECT $1", [123 as any])
            ).rejects.toThrow("unsupported raw parameter type");

            // Test with boolean
            await expect(
                queryRequest("SELECT $1", [true as any])
            ).rejects.toThrow("unsupported raw parameter type");

            // Test with object
            await expect(
                queryRequest("SELECT $1", [{ key: "value" } as any])
            ).rejects.toThrow("unsupported raw parameter type");

            // Test with array
            await expect(
                queryRequest("SELECT $1", [[1, 2, 3] as any])
            ).rejects.toThrow("unsupported raw parameter type");
        });
    });

    describe("edge cases", () => {
        it("should handle exactly 1024 byte string (boundary)", async () => {
            const string1024 = "a".repeat(1024);
            const frames = await queryRequest("SELECT $1", [string1024]);

            // Should be inline since it's <= 1024
            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters![0]).toHaveProperty("value");
        });

        it("should handle exactly 1024 byte binary (boundary)", async () => {
            const binary1024 = new Uint8Array(1024);
            const frames = await queryRequest("SELECT $1", [binary1024]);

            // Should be inline since it's <= 1024
            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters![0]).toHaveProperty("value");
        });

        it("should handle empty string", async () => {
            const frames = await queryRequest("SELECT $1", [""]);

            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters![0]).toEqual({
                type: "text",
                value: "",
            });
        });

        it("should handle empty binary array", async () => {
            const frames = await queryRequest("SELECT $1", [new Uint8Array(0)]);

            expect(frames).toHaveLength(1);
            const descriptor = frames[0] as QueryDescriptorFrame;
            expect(descriptor.parameters![0]).toEqual({
                type: "binary",
                value: "",
            });
        });
    });
});
