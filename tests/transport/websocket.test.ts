import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketError } from "../../src/common/types.ts";
import type { ColumnMetadata, RequestFrame } from "../../src/transport/frames.ts";
import type { TransportConfig } from "../../src/transport/shared.ts";
import { FRAME_URNS } from "../../src/transport/shared.ts";
import type { WebSocketTransport } from "../../src/transport/websocket.ts";
import { MockWebSocket, createMockWebSocketSetup, runEventLoop } from "./websocket-test-utils.ts";

// Setup mock WebSocket
const mockWsSetup = createMockWebSocketSetup();

// Mock the shims module
vi.mock("../../src/transport/shims.ts", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/transport/shims.ts")>();
    return {
        ...actual,
        createWebSocket: mockWsSetup.mockFactory,
    };
});

describe("WebSocketTransport", () => {
    const defaultConfig: TransportConfig = {
        endpoint: "http://localhost:3000",
        username: "testuser",
        password: "testpass",
    };

    let webSocketTransport: (config: TransportConfig) => WebSocketTransport;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockWsSetup.reset();
        global.WebSocket = MockWebSocket;

        const module = await import("../../src/transport/websocket.ts");
        webSocketTransport = module.webSocketTransport;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const getMockWs = () => mockWsSetup.getMockWs();

    // Helper to complete authentication
    async function authenticateTransport() {
        const transport = webSocketTransport(defaultConfig);
        await transport.connect();
        return transport;
    }

    // Helper to simulate a complete query response
    function simulateQueryResponse(columns: ColumnMetadata[], rows: (string | null)[][]) {
        // Send DataRowDescription
        getMockWs().simulateMessage(FRAME_URNS.dataRowDescriptionUrn);
        getMockWs().simulateMessage(JSON.stringify({ columns }));

        // Send DataRows
        for (const row of rows) {
            getMockWs().simulateMessage(FRAME_URNS.dataRowUrn);
            getMockWs().simulateMessage(JSON.stringify({ values: row }));
        }

        // Send CommandComplete
        getMockWs().simulateMessage(FRAME_URNS.commandCompleteUrn);
        getMockWs().simulateMessage(JSON.stringify({ complete: true }));
    }

    describe("connection", () => {
        it("should establish connection and authenticate", async () => {
            const transport = await authenticateTransport();

            expect(transport).toBeDefined();
            expect(transport.isConnected()).toBe(true);
        });

        it("should send auth frame on connection", async () => {
            await authenticateTransport();

            const sentMessages = getMockWs().sentMessages;
            expect(sentMessages.length).toBeGreaterThan(0);

            expect(sentMessages[0]).to.be.a("string");

            const authFrame = JSON.parse(sentMessages[0] as string);
            expect(authFrame).toEqual({
                username: "testuser",
                password: "testpass",
            });
        });
    });

    describe("statement() - query execution", () => {
        it("should execute a simple SELECT query", async () => {
            const transport = await authenticateTransport();

            const queryPromise = transport.statement("query", "SELECT id, name FROM users", []);

            // Wait for frames to be sent
            await runEventLoop();

            // Verify frames were sent
            const sentMessages = getMockWs().sentMessages;
            expect(sentMessages).toContain(FRAME_URNS.queryDescriptorUrn);

            // Find the query descriptor frame
            const queryDescriptorIndex = sentMessages.indexOf(FRAME_URNS.queryDescriptorUrn);

            expect(sentMessages[queryDescriptorIndex + 1]).to.be.a("string");

            const queryDescriptor = JSON.parse(sentMessages[queryDescriptorIndex + 1] as string);
            expect(queryDescriptor).toMatchObject({
                query: "SELECT id, name FROM users",
            });

            // Simulate server response
            simulateQueryResponse(
                [
                    { name: "id", typeOid: 23 },
                    { name: "name", typeOid: 25 },
                ],
                [
                    ["1", "Alice"],
                    ["2", "Bob"],
                ],
            );

            const response = await queryPromise;

            expect(response.columns).toEqual([
                { name: "id", oid: 23 },
                { name: "name", oid: 25 },
            ]);

            const rows = await response.rows.collect();
            expect(rows).toEqual([
                ["1", "Alice"],
                ["2", "Bob"],
            ]);
        });

        it("should execute query with parameters", async () => {
            const transport = await authenticateTransport();

            const queryPromise = transport.statement("query", "SELECT * FROM users WHERE id = $1", ["42"]);

            await runEventLoop();

            // Verify query frame with parameters
            const sentMessages = getMockWs().sentMessages;
            const queryDescriptorIndex = sentMessages.indexOf(FRAME_URNS.queryDescriptorUrn);

            expect(sentMessages[queryDescriptorIndex + 1]).to.be.a("string");

            const queryDescriptor = JSON.parse(sentMessages[queryDescriptorIndex + 1] as string);

            expect(queryDescriptor.query).toBe("SELECT * FROM users WHERE id = $1");
            expect(queryDescriptor.parameters).toHaveLength(1);
            expect(queryDescriptor.parameters[0]).toMatchObject({ type: expect.any(String), value: "42" });

            simulateQueryResponse([{ name: "id", typeOid: 23 }], [["42"]]);

            const response = await queryPromise;
            const rows = await response.rows.collect();
            expect(rows).toEqual([["42"]]);
        });

        it("should execute exec statement kind", async () => {
            const transport = await authenticateTransport();

            const queryPromise = transport.statement("exec", "INSERT INTO users (name) VALUES ($1)", ["Charlie"]);

            await runEventLoop();

            const sentMessages = getMockWs().sentMessages;
            const queryDescriptorIndex = sentMessages.indexOf(FRAME_URNS.queryDescriptorUrn);

            expect(sentMessages[queryDescriptorIndex + 1]).to.be.a("string");

            const queryDescriptor = JSON.parse(sentMessages[queryDescriptorIndex + 1] as string);

            expect(queryDescriptor.exec).toBe("INSERT INTO users (name) VALUES ($1)");

            // Simulate command complete without rows
            getMockWs().simulateMessage(FRAME_URNS.commandCompleteUrn);
            getMockWs().simulateMessage(JSON.stringify({ complete: true }));

            const response = await queryPromise;
            expect(response.columns).toEqual([]);
        });

        it("should handle query with no results", async () => {
            const transport = await authenticateTransport();

            const queryPromise = transport.statement("query", "SELECT * FROM users WHERE id = -1", []);

            await runEventLoop();

            simulateQueryResponse([{ name: "id", typeOid: 23 }], []);

            const response = await queryPromise;
            const rows = await response.rows.collect();
            expect(rows).toEqual([]);
        });

        it("should handle multiple sequential queries", async () => {
            const transport = await authenticateTransport();

            // First query
            const query1Promise = transport.statement("query", "SELECT 1", []);
            await runEventLoop();
            simulateQueryResponse([{ name: "?column?", typeOid: 23 }], [["1"]]);
            const response1 = await query1Promise;
            const rows1 = await response1.rows.collect();
            expect(rows1).toEqual([["1"]]);

            // Second query
            const query2Promise = transport.statement("query", "SELECT 2", []);
            await runEventLoop();
            simulateQueryResponse([{ name: "?column?", typeOid: 23 }], [["2"]]);
            const response2 = await query2Promise;
            const rows2 = await response2.rows.collect();
            expect(rows2).toEqual([["2"]]);
        });

        it("should handle concurrent queries without frame interleaving", async () => {
            const transport = await authenticateTransport();

            // Start 3 queries concurrently without awaiting
            const query1Promise = transport.statement("query", "SELECT 'query1'", []);
            const query2Promise = transport.statement("query", "SELECT 'query2'", []);
            const query3Promise = transport.statement("query", "SELECT 'query3'", []);

            await runEventLoop();

            // Verify frames were sent in order (not interleaved)
            const sentMessages = getMockWs().sentMessages;

            // Find all QueryDescriptor URNs
            const urnIndices: number[] = [];
            sentMessages.forEach((msg, index) => {
                if (msg === FRAME_URNS.queryDescriptorUrn) {
                    urnIndices.push(index);
                }
            });

            expect(urnIndices.length).toBe(3);

            // Verify each query's frames are contiguous (URN followed immediately by payload)
            expect(sentMessages[urnIndices[0] + 1]).to.be.a("string");
            expect(sentMessages[urnIndices[1] + 1]).to.be.a("string");
            expect(sentMessages[urnIndices[2] + 1]).to.be.a("string");

            const query1Data = JSON.parse(sentMessages[urnIndices[0] + 1] as string);
            const query2Data = JSON.parse(sentMessages[urnIndices[1] + 1] as string);
            const query3Data = JSON.parse(sentMessages[urnIndices[2] + 1] as string);

            expect(query1Data.query).toBe("SELECT 'query1'");
            expect(query2Data.query).toBe("SELECT 'query2'");
            expect(query3Data.query).toBe("SELECT 'query3'");

            // Respond to all queries
            simulateQueryResponse([{ name: "?column?", typeOid: 25 }], [["query1"]]);
            simulateQueryResponse([{ name: "?column?", typeOid: 25 }], [["query2"]]);
            simulateQueryResponse([{ name: "?column?", typeOid: 25 }], [["query3"]]);

            const [response1, response2, response3] = await Promise.all([query1Promise, query2Promise, query3Promise]);

            const rows1 = await response1.rows.collect();
            const rows2 = await response2.rows.collect();
            const rows3 = await response3.rows.collect();

            expect(rows1).toEqual([["query1"]]);
            expect(rows2).toEqual([["query2"]]);
            expect(rows3).toEqual([["query3"]]);
        });
    });

    describe("error handling", () => {
        it("should reject when connection is not ready", async () => {
            const transport = await authenticateTransport();

            // Close the connection
            getMockWs().readyState = MockWebSocket.CLOSED;

            await expect(transport.statement("query", "SELECT 1", [])).rejects.toThrow("WebSocket is not connected");
        });

        it("should handle server error responses", async () => {
            const transport = await authenticateTransport();

            const queryPromise = transport.statement("query", "SELECT * FROM nonexistent", []);

            await runEventLoop();

            // Simulate error response
            getMockWs().simulateMessage(FRAME_URNS.errorUrn);
            getMockWs().simulateMessage(
                JSON.stringify({
                    error: {
                        message: 'relation "nonexistent" does not exist',
                        code: "42P01",
                    },
                }),
            );

            await expect(queryPromise).rejects.toThrow('relation "nonexistent" does not exist');
        });

        it("should handle WebSocket close during query", async () => {
            const transport = await authenticateTransport();

            const queryPromise = transport.statement("query", "SELECT 1", []);

            await runEventLoop();

            // Simulate connection close
            getMockWs().simulateClose(1006, "Connection lost");

            await expect(queryPromise).rejects.toThrow(
                new WebSocketError({
                    message: "WebSocket connection closed",
                    closureCode: 1006,
                    closureReason: "Connection lost",
                }),
            );
        });

        it("should reject ExtendedParamFrame with unsupported data type", async () => {
            const transport = await authenticateTransport();

            // Mock requestFrames to return an ExtendedParamFrame with unsupported data type
            vi.spyOn(await import("../../src/transport/frames.ts"), "requestFrames").mockResolvedValue([
                {
                    type: "text",
                    data: 12345 as unknown, // Unsupported: number
                } as RequestFrame,
            ]);

            const queryPromise = transport.statement("query", "SELECT $1", []);

            await expect(queryPromise).rejects.toThrow("Unsupported extended parameter data type: number");

            vi.restoreAllMocks();
        });
    });

    describe("connection state", () => {
        it("should return true for isConnected when connected", async () => {
            const transport = await authenticateTransport();

            expect(transport.isConnected()).toBe(true);
        });

        it("should return false for isConnected when closed", async () => {
            const transport = await authenticateTransport();

            getMockWs().readyState = MockWebSocket.CLOSED;

            expect(transport.isConnected()).toBe(false);
        });
    });

    describe("extended parameters - direct frame testing", () => {
        it("should handle ExtendedParamFrame with string data directly", async () => {
            const transport = await authenticateTransport();

            // Mock requestFrames to return an ExtendedParamFrame with string data
            vi.spyOn(await import("../../src/transport/frames.ts"), "requestFrames").mockResolvedValue([
                {
                    type: "text",
                    data: "Direct string data",
                } as RequestFrame,
            ]);

            const queryPromise = transport.statement("query", "SELECT $1", []);

            await runEventLoop();

            const sentMessages = getMockWs().sentMessages;
            expect(sentMessages).toContain(FRAME_URNS.textParamUrn);

            const textParamIndex = sentMessages.indexOf(FRAME_URNS.textParamUrn);
            const textData = sentMessages[textParamIndex + 1];

            // Should send string directly (line 91)
            expect(typeof textData).toBe("string");
            expect(textData).toBe("Direct string data");

            getMockWs().simulateMessage(FRAME_URNS.commandCompleteUrn);
            getMockWs().simulateMessage(JSON.stringify({ complete: true }));

            await queryPromise;

            vi.restoreAllMocks();
        });
    });

    describe("extended parameters", () => {
        it("should handle extended text param as string (large string parameter)", async () => {
            const transport = await authenticateTransport();

            // Create a large string that will trigger extended parameter handling
            const largeText = "x".repeat(2000); // Over 1KB threshold
            const queryPromise = transport.statement("query", "INSERT INTO docs (content) VALUES ($1)", [largeText]);

            await runEventLoop();

            // Verify extended text parameter frame was sent
            const sentMessages = getMockWs().sentMessages;
            expect(sentMessages).toContain(FRAME_URNS.textParamUrn);

            // Find the text param data (should be after the URN)
            const textParamIndex = sentMessages.indexOf(FRAME_URNS.textParamUrn);
            const textData = sentMessages[textParamIndex + 1];

            // Should be sent as string directly (line 91)
            expect(typeof textData).toBe("string");
            expect(textData).toBe(largeText);

            // Complete the query
            getMockWs().simulateMessage(FRAME_URNS.commandCompleteUrn);
            getMockWs().simulateMessage(JSON.stringify({ complete: true }));

            const response = await queryPromise;
            expect(response.columns).toEqual([]);
        });

        it("should handle extended text param as Uint8Array (large ByteArrayParameter with text format)", async () => {
            const transport = await authenticateTransport();

            const { byteArrayParameter } = await import("../../src/common/types.ts");
            const encoder = new TextEncoder();
            const largeText = "y".repeat(2000); // Over 1KB
            const textBytes = encoder.encode(largeText);
            const textParam = byteArrayParameter(textBytes, "text");

            const queryPromise = transport.statement("query", "INSERT INTO docs (content) VALUES ($1)", [textParam]);

            await runEventLoop();

            const sentMessages = getMockWs().sentMessages;
            expect(sentMessages).toContain(FRAME_URNS.textParamUrn);

            const textParamIndex = sentMessages.indexOf(FRAME_URNS.textParamUrn);
            const textData = sentMessages[textParamIndex + 1];

            // Should be sent as Uint8Array directly (line 93)
            expect(textData).toBeInstanceOf(Uint8Array);
            expect(textData).toEqual(textBytes);

            getMockWs().simulateMessage(FRAME_URNS.commandCompleteUrn);
            getMockWs().simulateMessage(JSON.stringify({ complete: true }));

            const response = await queryPromise;
            expect(response.columns).toEqual([]);
        });

        it("should handle extended binary param as Uint8Array (large binary ByteArrayParameter)", async () => {
            const transport = await authenticateTransport();

            const { byteArrayParameter } = await import("../../src/common/types.ts");
            const largeData = new Uint8Array(2000).fill(42); // Over 1KB
            const binaryParam = byteArrayParameter(largeData, "binary");

            const queryPromise = transport.statement("query", "INSERT INTO blobs VALUES ($1)", [binaryParam]);

            await runEventLoop();

            const sentMessages = getMockWs().sentMessages;
            expect(sentMessages).toContain(FRAME_URNS.binaryParamUrn);

            const binaryParamIndex = sentMessages.indexOf(FRAME_URNS.binaryParamUrn);
            const binaryData = sentMessages[binaryParamIndex + 1];

            // Should be sent as Uint8Array directly (lines 101-104)
            expect(binaryData).toBeInstanceOf(Uint8Array);
            expect(binaryData).toEqual(largeData);

            getMockWs().simulateMessage(FRAME_URNS.commandCompleteUrn);
            getMockWs().simulateMessage(JSON.stringify({ complete: true }));

            const response = await queryPromise;
            expect(response.columns).toEqual([]);
        });

        it("should handle text param as ReadableStream (large BoundedByteStreamParameter with text format)", async () => {
            const transport = await authenticateTransport();

            const { boundedByteStreamParameter } = await import("../../src/common/types.ts");
            const largeText = "z".repeat(2000); // Over 1KB
            const encoder = new TextEncoder();
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode(largeText));
                    controller.close();
                },
            });
            const streamParam = boundedByteStreamParameter(stream, "text", encoder.encode(largeText).byteLength);

            const queryPromise = transport.statement("query", "INSERT INTO docs (content) VALUES ($1)", [streamParam]);

            await runEventLoop();

            const sentMessages = getMockWs().sentMessages;
            expect(sentMessages).toContain(FRAME_URNS.textParamUrn);

            const textParamIndex = sentMessages.indexOf(FRAME_URNS.textParamUrn);
            const textData = sentMessages[textParamIndex + 1];

            // Stream should be consumed to string (lines 95-97)
            expect(typeof textData).toBe("string");
            expect(textData).toBe(largeText);

            getMockWs().simulateMessage(FRAME_URNS.commandCompleteUrn);
            getMockWs().simulateMessage(JSON.stringify({ complete: true }));

            const response = await queryPromise;
            expect(response.columns).toEqual([]);
        });

        it("should handle binary param as ReadableStream (large BoundedByteStreamParameter with binary format)", async () => {
            const transport = await authenticateTransport();

            const { boundedByteStreamParameter } = await import("../../src/common/types.ts");
            const largeData = new Uint8Array(2000).fill(99);
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(largeData);
                    controller.close();
                },
            });
            const streamParam = boundedByteStreamParameter(stream, "binary", largeData.byteLength);

            const queryPromise = transport.statement("query", "INSERT INTO blobs VALUES ($1)", [streamParam]);

            await runEventLoop();

            const sentMessages = getMockWs().sentMessages;
            expect(sentMessages).toContain(FRAME_URNS.binaryParamUrn);

            const binaryParamIndex = sentMessages.indexOf(FRAME_URNS.binaryParamUrn);
            const binaryData = sentMessages[binaryParamIndex + 1];

            // Stream should be consumed to Uint8Array (lines 105-108)
            expect(binaryData).toBeInstanceOf(Uint8Array);
            expect(binaryData).toEqual(largeData);

            getMockWs().simulateMessage(FRAME_URNS.commandCompleteUrn);
            getMockWs().simulateMessage(JSON.stringify({ complete: true }));

            const response = await queryPromise;
            expect(response.columns).toEqual([]);
        });
    });

    describe("close() and dispose", () => {
        it("should close connection via close()", async () => {
            const transport = await authenticateTransport();

            const closeSpy = vi.spyOn(getMockWs(), "close");

            await transport.close();

            expect(closeSpy).toHaveBeenCalledWith(1000, "Normal closure");
        });

        it("should close connection via Symbol.asyncDispose", async () => {
            const transport = await authenticateTransport();

            const closeSpy = vi.spyOn(getMockWs(), "close");

            transport[Symbol.dispose]();

            expect(closeSpy).toHaveBeenCalledWith(1000, "Normal closure");
        });

        it("should work with using declaration pattern", async () => {
            const closeSpy = vi.fn();

            {
                const transport = await authenticateTransport();
                vi.spyOn(getMockWs(), "close").mockImplementation(closeSpy);

                // In real code: await using transport = await webSocketTransport(config);
                // Manually call dispose for testing
                transport[Symbol.dispose]();
            }

            expect(closeSpy).toHaveBeenCalled();
        });
    });
});
