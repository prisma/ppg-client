import { Readable } from "node:stream";
import Busboy from "busboy";
import { expect, vi } from "vitest";
import { BINARY, byteArrayParameter } from "../../src/common/types.ts";
import type { ExtendedParamFrame, QueryDescriptorFrame, ResponseFrame } from "../../src/transport/frames.ts";
import { utf8ByteLength } from "../../src/transport/shims.ts";

/**
 * Mock HTTP Server for testing the HTTP transport.
 * Uses fetch mocking to intercept requests without a real HTTP server.
 */
export class MockHttpServer {
    private expectedFrames: ExpectedFrame[] = [];
    private responseFrames: ResponseFrame[] = [];
    private receivedFrames: (QueryDescriptorFrame | ExtendedParamFrame)[] = [];
    private receivedRequest: ReceivedRequest | null = null;

    /**
     * Install the fetch mock
     */
    install(): void {
        global.fetch = vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
            // Capture request details
            this.receivedRequest = {
                url: url.toString(),
                method: init?.method || "GET",
                headers: (init?.headers as Record<string, string>) || {},
                body: init?.body,
            };

            // Parse multipart body
            if (init?.body) {
                const contentType = (init.headers as Record<string, string>)?.["Content-Type"] || "";
                const boundaryMatch = contentType.match(/boundary=([^;]+)/);
                if (boundaryMatch) {
                    const boundary = boundaryMatch[1];
                    this.receivedFrames = await this.parseMultipartBody(init.body, boundary);
                }
            }

            // Verify expectations
            this.checkExpectations();

            // Return mocked response
            const ndjson = this.createNDJSONResponse(this.responseFrames);

            // Convert Node.js Readable to Web ReadableStream
            const webStream = new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(ndjson));
                    controller.close();
                },
            });

            return new Response(webStream, {
                status: 200,
                headers: {
                    "Content-Type": "application/x-ndjson",
                },
            });
        }) as typeof fetch;
    }

    /**
     * Uninstall the fetch mock
     */
    uninstall(): void {
        vi.restoreAllMocks();
    }

    /**
     * Parse multipart body using busboy library
     */
    private async parseMultipartBody(
        body: BodyInit,
        boundary: string,
    ): Promise<(QueryDescriptorFrame | ExtendedParamFrame)[]> {
        return new Promise((resolve, reject) => {
            const frames: (QueryDescriptorFrame | ExtendedParamFrame)[] = [];

            // Convert body to Node.js Readable stream
            let stream: Readable;
            if (body instanceof ReadableStream) {
                // Convert Web ReadableStream to Node.js Readable
                stream = Readable.from(this.webStreamToAsyncIterator(body));
            } else if (body instanceof Uint8Array) {
                stream = Readable.from(Buffer.from(body));
            } else {
                reject(new Error("Unsupported body type for testing"));
                return;
            }

            // Create busboy instance
            const busboy = Busboy({
                headers: {
                    "content-type": `multipart/form-data; boundary=${boundary}`,
                },
            });

            // Track parts order since busboy processes them asynchronously
            const pendingParts: Array<{ order: number; frame: QueryDescriptorFrame | ExtendedParamFrame }> = [];
            let partIndex = 0;

            // Helper function to process frame data
            const processFrame = (fieldname: string, data: string | Buffer, order: number) => {
                switch (fieldname) {
                    case "urn:prisma:query:descriptor": {
                        // Query descriptor - parse as JSON
                        const dataStr = typeof data === "string" ? data : data.toString("utf-8");
                        const descriptor = JSON.parse(dataStr) as QueryDescriptorFrame;
                        pendingParts.push({ order, frame: descriptor });
                        break;
                    }

                    case "urn:prisma:query:param:text": {
                        // Text parameter
                        const textData = typeof data === "string" ? data : data.toString("utf-8");
                        pendingParts.push({
                            order,
                            frame: {
                                type: "text",
                                data: textData,
                            },
                        });
                        break;
                    }

                    case "urn:prisma:query:param:binary": {
                        // Binary parameter
                        const binaryData =
                            typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
                        pendingParts.push({
                            order,
                            frame: {
                                type: "binary",
                                data: byteArrayParameter(binaryData, BINARY),
                            },
                        });
                        break;
                    }
                }
            };

            // Handle "field" events (busboy treats parts without filename as fields)
            busboy.on("field", (fieldname, value) => {
                const currentIndex = partIndex++;
                processFrame(fieldname, value, currentIndex);
            });

            // Handle "file" events (busboy may treat binary data as files)
            busboy.on("file", (fieldname, file, _info) => {
                const currentIndex = partIndex++;
                const chunks: Buffer[] = [];

                file.on("data", (chunk: Buffer) => {
                    chunks.push(chunk);
                });

                file.on("end", () => {
                    const combined = Buffer.concat(chunks);
                    processFrame(fieldname, combined, currentIndex);
                });
            });

            busboy.on("finish", () => {
                // Sort by order and extract frames
                pendingParts.sort((a, b) => a.order - b.order);
                frames.push(...pendingParts.map((p) => p.frame));
                resolve(frames);
            });

            busboy.on("error", (err: Error) => {
                reject(err);
            });

            // Pipe the stream to busboy
            stream.pipe(busboy);
        });
    }

    /**
     * Helper to convert Web ReadableStream to async iterator for Node.js Readable
     */
    private async *webStreamToAsyncIterator(stream: ReadableStream<Uint8Array>): AsyncIterableIterator<Uint8Array> {
        const reader = stream.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                yield value;
            }
        } finally {
            reader.releaseLock();
        }
    }

    /**
     * Create NDJSON response from frames
     */
    private createNDJSONResponse(frames: ResponseFrame[]): string {
        return `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`;
    }

    /**
     * Check if received frames match expectations
     */
    private checkExpectations(): void {
        if (this.expectedFrames.length === 0) return;

        for (let i = 0; i < this.expectedFrames.length; i++) {
            const expected = this.expectedFrames[i];
            const received = this.receivedFrames[i];

            expect(received, `Expected frame ${i} (${expected.type}) but got nothing`).toBeDefined();

            this.verifyFrame(expected, received, i);
        }
    }

    /**
     * Verify a single frame matches expectations
     */
    private verifyFrame(
        expected: ExpectedFrame,
        received: QueryDescriptorFrame | ExtendedParamFrame,
        index: number,
    ): void {
        if (expected.type === "query-descriptor") {
            // Verify it's a query descriptor frame
            expect(
                "query" in received || "exec" in received,
                `Frame ${index}: Expected query descriptor but got ${JSON.stringify(received)}`,
            ).toBe(true);

            const descriptor = received as QueryDescriptorFrame;
            const expectations = expected.expectations;

            // Verify kind (query vs exec)
            if (expectations.kind !== undefined) {
                expect(
                    expectations.kind in descriptor,
                    `Frame ${index}: Expected '${expectations.kind}' kind but got '${Object.keys(descriptor).join()}'`,
                ).toBe(true);
            }

            // Verify SQL
            if (expectations.sql !== undefined) {
                const sql = "query" in descriptor ? descriptor.query : descriptor.exec;
                expect(sql, `Frame ${index}: SQL mismatch`).toBe(expectations.sql);
            }

            // Verify parameter count
            if (expectations.parameterCount !== undefined) {
                const actualCount = descriptor.parameters?.length || 0;
                expect(actualCount, `Frame ${index}: Parameter count mismatch`).toBe(expectations.parameterCount);
            }
        } else if (expected.type === "text-param") {
            // Verify it's a text parameter frame
            expect(
                "type" in received && received.type === "text",
                `Frame ${index}: Expected text param but got ${JSON.stringify(received)}`,
            ).toBe(true);

            const textParam = received as ExtendedParamFrame;

            // Verify content
            if (typeof expected.expectations === "string") {
                const data = textParam.data;
                const actualText = typeof data === "string" ? data : new TextDecoder().decode(data as Uint8Array);
                expect(actualText, `Frame ${index}: Text content mismatch`).toBe(expected.expectations);
            } else if (expected.expectations?.byteSize !== undefined) {
                const data = textParam.data;
                const actualSize = typeof data === "string" ? utf8ByteLength(data) : (data as Uint8Array).length;
                expect(actualSize, `Frame ${index}: Byte size mismatch`).toBe(expected.expectations.byteSize);
            }
        } else if (expected.type === "binary-param") {
            // Verify it's a binary parameter frame
            expect(
                "type" in received && received.type === "binary",
                `Frame ${index}: Expected binary param but got ${JSON.stringify(received)}`,
            ).toBe(true);

            const binaryParam = received as ExtendedParamFrame;

            // Verify content
            if (expected.expectations instanceof Uint8Array) {
                const actualData = binaryParam.data as Uint8Array;
                expect(actualData.length, `Frame ${index}: Binary length mismatch`).toBe(expected.expectations.length);
                // Could add byte-by-byte comparison:
                // expect(actualData).toEqual(expected.expectations);
            } else if (expected.expectations?.byteSize !== undefined) {
                const actualSize = (binaryParam.data as Uint8Array).length;
                expect(actualSize, `Frame ${index}: Byte size mismatch`).toBe(expected.expectations.byteSize);
            }
        }
    }

    /**
     * Expect a query descriptor frame with specific properties
     */
    expectQueryDescriptor(expectations: {
        kind?: "query" | "exec";
        sql?: string;
        parameterCount?: number;
    }): this {
        this.expectedFrames.push({
            type: "query-descriptor",
            expectations,
        });
        return this;
    }

    /**
     * Expect a text parameter frame
     */
    expectTextParam(expectedContent?: string | { byteSize: number }): this {
        this.expectedFrames.push({
            type: "text-param",
            expectations: expectedContent,
        });
        return this;
    }

    /**
     * Expect a binary parameter frame
     */
    expectBinaryParam(expectedContent?: Uint8Array | { byteSize: number }): this {
        this.expectedFrames.push({
            type: "binary-param",
            expectations: expectedContent,
        });
        return this;
    }

    /**
     * Configure response: send column descriptor
     */
    respondWithColumns(columns: { name: string; typeOid: number }[]): this {
        this.responseFrames.push({
            columns,
        });
        return this;
    }

    /**
     * Configure response: send data row
     */
    respondWithRow(values: (string | null)[]): this {
        this.responseFrames.push({
            values,
        });
        return this;
    }

    /**
     * Configure response: send command complete
     */
    respondWithComplete(): this {
        this.responseFrames.push({
            complete: true,
        });
        return this;
    }

    /**
     * Configure response: send error
     */
    respondWithError(error: { message: string; code?: string; [key: string]: string | undefined }): this {
        const { message, code, ...rest } = error;
        this.responseFrames.push({
            error: {
                message,
                code: code || "ERROR",
                ...rest,
            },
        });
        return this;
    }

    /**
     * Verify authentication header
     */
    verifyAuth(username: string, password: string): void {
        expect(this.receivedRequest, "No request received").toBeDefined();

        const authHeader = this.receivedRequest!.headers.Authorization;
        expect(authHeader, "No Authorization header found").toBeDefined();

        const expected = `Basic ${btoa(`${username}:${password}`)}`;
        expect(authHeader, "Auth header mismatch").toBe(expected);
    }

    /**
     * Get received frames for inspection
     */
    getReceivedFrames(): (QueryDescriptorFrame | ExtendedParamFrame)[] {
        return this.receivedFrames;
    }

    /**
     * Get received request for inspection
     */
    getReceivedRequest(): ReceivedRequest | null {
        return this.receivedRequest;
    }

    /**
     * Reset expectations and responses
     */
    reset(): void {
        this.expectedFrames = [];
        this.responseFrames = [];
        this.receivedFrames = [];
        this.receivedRequest = null;
    }
}

export type ExpectedFrame =
    | {
          type: "query-descriptor";
          expectations: {
              kind?: "query" | "exec";
              sql?: string;
              parameterCount?: number;
          };
      }
    | {
          type: "text-param";
          expectations?: string | { byteSize: number };
      }
    | {
          type: "binary-param";
          expectations?: Uint8Array | { byteSize: number };
      };

export type ReceivedRequest = {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: BodyInit | null | undefined;
};
