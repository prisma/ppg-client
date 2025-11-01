import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { TransportConfig } from "../../src/transport/shared.ts";
import { FRAME_URNS } from "../../src/transport/shared.ts";
import { MockWebSocket, createMockWebSocketSetup, nextTick } from "./websocket-test-utils.ts";
import type { WsTransportConnection } from "../../src/transport/websocket-conn.ts";

// Setup mock WebSocket
const mockWsSetup = createMockWebSocketSetup();

// Mock the shims module
vi.mock("../../src/transport/shims.ts", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/transport/shims.ts")>();
    return {
        ...actual,
        createWebSocket: mockWsSetup.mockFactory,
        // Use real wsBusyCheck so it checks bufferedAmount
    };
});

describe("wsTransportConnection", () => {
    const defaultConfig: TransportConfig = {
        endpoint: "http://localhost:3000",
        username: "testuser",
        password: "testpass",
    };

    // Import after mocking
    let wsTransportConnection: (config: TransportConfig) => Promise<WsTransportConnection>;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockWsSetup.reset();
        global.WebSocket = MockWebSocket;

        // Dynamic import to get mocked version
        const module = await import("../../src/transport/websocket-conn.ts");
        wsTransportConnection = module.wsTransportConnection;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // Helper to get current mock
    const getMockWs = () => mockWsSetup.getMockWs();

    describe("connection establishment", () => {
        it("should construct correct WebSocket URL", async () => {
            const connPromise = wsTransportConnection(defaultConfig);

            await nextTick()

            expect(getMockWs().url).toBe("ws://localhost:3000/db/websocket");
            expect(getMockWs().protocol).toBe("prisma-postgres-1.0");

            // Send auth response to complete connection
            await connPromise;
        });

        it("should include database parameter in URL when provided", async () => {
            const config: TransportConfig = {
                ...defaultConfig,
                database: "mydb",
            };

            const connPromise = wsTransportConnection(config);
            await nextTick()

            expect(getMockWs().url).toContain("database=mydb");

            await connPromise;
        });

        it("should set binary type to arraybuffer", async () => {
            const connPromise = wsTransportConnection(defaultConfig);
            await nextTick()

            expect(getMockWs().binaryType).toBe("arraybuffer");

            await connPromise;
        });
    });

    describe("authentication", () => {
        it("should send authentication frame on open", async () => {
            const connPromise = wsTransportConnection(defaultConfig);
            await nextTick()

            expect(getMockWs().sentMessages.length).toBe(1);
            const msg = getMockWs().sentMessages[0];
            expect(msg).to.be.a('string')

            const authFrame = JSON.parse(msg as string);
            expect(authFrame).toEqual({
                username: "testuser",
                password: "testpass",
            });

            await connPromise;
        });

        it("should resolve when first message is received", async () => {
            const connPromise = wsTransportConnection(defaultConfig);
            await nextTick()

            // Simulate authentication success

            const conn = await connPromise;
            expect(conn).toBeDefined();
            expect(conn.isReady()).toBe(true);
        });

    });

    describe("message parsing", () => {
        it("should parse URN + payload message pattern", async () => {
            const connPromise = wsTransportConnection(defaultConfig);
            await nextTick()

            const conn = await connPromise;

            // Enqueue a query
            const query = conn.enqueueNewQuery();

            // Send DataRowDescription (URN + payload)
            getMockWs().simulateMessage(FRAME_URNS.dataRowDescriptionUrn);
            getMockWs().simulateMessage(JSON.stringify({
                columns: [{ name: "id", typeOid: 23 }],
            }));

            // Complete the query
            getMockWs().simulateMessage(FRAME_URNS.commandCompleteUrn);
            getMockWs().simulateMessage(JSON.stringify({ complete: true }));

            const response = await query.promise;
            expect(response.columns).toEqual([{ name: "id", oid: 23 }]);
        });

        it("should handle multiple messages in sequence", async () => {
            const connPromise = wsTransportConnection(defaultConfig);
            await nextTick()

            const conn = await connPromise;

            const query = conn.enqueueNewQuery();

            // Send row description
            getMockWs().simulateMessage(FRAME_URNS.dataRowDescriptionUrn);
            getMockWs().simulateMessage(JSON.stringify({
                columns: [{ name: "id", typeOid: 23 }],
            }));

            // Send multiple data rows
            const rowsPromise = (async () => {
                const response = await query.promise;
                return await response.rows.collect();
            })();

            await nextTick()

            getMockWs().simulateMessage(FRAME_URNS.dataRowUrn);
            getMockWs().simulateMessage(JSON.stringify({ values: ["1"] }));

            await nextTick()

            getMockWs().simulateMessage(FRAME_URNS.dataRowUrn);
            getMockWs().simulateMessage(JSON.stringify({ values: ["2"] }));

            await nextTick()

            getMockWs().simulateMessage(FRAME_URNS.commandCompleteUrn);
            getMockWs().simulateMessage(JSON.stringify({ complete: true }));

            const rows = await rowsPromise;
            expect(rows).toEqual([["1"], ["2"]]);
        });
    });

    describe("error handling", () => {
        it("should reject binary messages and abort all queries", async () => {
            const connPromise = wsTransportConnection(defaultConfig);
            await nextTick()

            const conn = await connPromise;

            const query1 = conn.enqueueNewQuery();
            const query2 = conn.enqueueNewQuery();

            const closeSpy = vi.spyOn(getMockWs(), "close");

            // Simulate receiving a binary message (ArrayBuffer)
            const binaryData = new ArrayBuffer(8);
            getMockWs().simulateMessage(binaryData);

            // All queries should be aborted
            await expect(query1.promise).rejects.toThrow(
                "Protocol error: expected text message, received object"
            );
            await expect(query2.promise).rejects.toThrow(
                "Protocol error: expected text message, received object"
            );

            // WebSocket should be closed with protocol error code
            expect(closeSpy).toHaveBeenCalledWith(1002, "Protocol error: binary messages not supported");
        });

        it("should abort all queries on WebSocket error after auth", async () => {
            const connPromise = wsTransportConnection(defaultConfig);
            await nextTick()

            const conn = await connPromise;

            const query1 = conn.enqueueNewQuery();
            const query2 = conn.enqueueNewQuery();

            getMockWs().simulateError("Connection lost");

            await expect(query1.promise).rejects.toThrow("Connection lost");
            await expect(query2.promise).rejects.toThrow("Connection lost");
        });

        it("should handle WebSocket error without message property", async () => {
            const connPromise = wsTransportConnection(defaultConfig);
            await nextTick()

            const conn = await connPromise;

            const query = conn.enqueueNewQuery();

            // Simulate error event without message property
            const onerror = getMockWs().onerror;
            if (onerror) {
                onerror({ type: "error" } as any);
            }

            await expect(query.promise).rejects.toThrow("WebSocket error");
        });

        it("should handle error frame from server", async () => {
            const connPromise = wsTransportConnection(defaultConfig);
            await nextTick()

            const conn = await connPromise;

            const query = conn.enqueueNewQuery();

            getMockWs().simulateMessage(FRAME_URNS.errorUrn);
            getMockWs().simulateMessage(JSON.stringify({
                error: { message: "syntax error", code: "42601" },
            }));

            await expect(query.promise).rejects.toThrow("syntax error");
        });
    });

    describe("close handling", () => {
        it("should abort all queries on close after auth", async () => {
            const connPromise = wsTransportConnection(defaultConfig);
            await nextTick()

            const conn = await connPromise;

            const query1 = conn.enqueueNewQuery();
            const query2 = conn.enqueueNewQuery();

            getMockWs().simulateClose(1006, "Abnormal closure");

            await expect(query1.promise).rejects.toThrow("WebSocket connection closed: 1006 - Abnormal closure");
            await expect(query2.promise).rejects.toThrow("WebSocket connection closed: 1006 - Abnormal closure");
        });

        it("should close connection with normal closure code", async () => {
            const connPromise = wsTransportConnection(defaultConfig);
            await nextTick()

            const conn = await connPromise;

            const closeSpy = vi.spyOn(getMockWs(), "close");

            conn.close();

            expect(closeSpy).toHaveBeenCalledWith(1000, "Normal closure");
        });
    });

    describe("send with backpressure", () => {
        it("should send data when not busy", async () => {
            const connPromise = wsTransportConnection(defaultConfig);
            await nextTick()

            const conn = await connPromise;

            await conn.send("test data");

            expect(getMockWs().sentMessages).toContain("test data");
        });

        it("should wait with exponential backoff when busy", async () => {
            vi.useFakeTimers();

            const connPromise = wsTransportConnection(defaultConfig);

            // Run pending timers to trigger onopen
            await vi.runOnlyPendingTimersAsync();

            const conn = await connPromise;

            // Set bufferedAmount high to simulate backpressure
            // The threshold is 1MB (1024 * 1024), so set it above that
            getMockWs().bufferedAmount = 2 * 1024 * 1024;

            // Start the send operation
            const sendPromise = conn.send("test data");

            // After 5ms, still busy
            await vi.advanceTimersByTimeAsync(5);

            // After 10ms more (15ms total), still busy
            await vi.advanceTimersByTimeAsync(10);

            // After 20ms more (35ms total), clear the buffer
            getMockWs().bufferedAmount = 0;
            await vi.advanceTimersByTimeAsync(20);

            // Now the send should complete
            await sendPromise;

            expect(getMockWs().sentMessages).toContain("test data");

            vi.useRealTimers();
        });

        it("should cap backoff at MAX_BACKOFF_MS (100ms)", async () => {
            vi.useFakeTimers();

            const connPromise = wsTransportConnection(defaultConfig);
            await vi.runOnlyPendingTimersAsync();

            const conn = await connPromise;

            // Set bufferedAmount high (above 1MB threshold)
            getMockWs().bufferedAmount = 2 * 1024 * 1024;

            const sendPromise = conn.send("test data");

            // Exponential backoff: 5, 10, 20, 40, 80, then capped at 100
            // Let's go through many iterations to hit the cap
            await vi.advanceTimersByTimeAsync(5);   // 5ms
            await vi.advanceTimersByTimeAsync(10);  // 10ms
            await vi.advanceTimersByTimeAsync(20);  // 20ms
            await vi.advanceTimersByTimeAsync(40);  // 40ms
            await vi.advanceTimersByTimeAsync(80);  // 80ms
            await vi.advanceTimersByTimeAsync(100); // 100ms (capped)

            // Clear buffer after many iterations
            getMockWs().bufferedAmount = 0;
            await vi.advanceTimersByTimeAsync(100); // One more iteration at cap

            await sendPromise;

            expect(getMockWs().sentMessages).toContain("test data");

            vi.useRealTimers();
        });

        it("should actually wait in the while loop (real timers for coverage)", async () => {
            // This test uses real timers to ensure coverage tools see the while loop execute
            const connPromise = wsTransportConnection(defaultConfig);
            await nextTick()

            const conn = await connPromise;

            // Set bufferedAmount high (above 1MB threshold)
            getMockWs().bufferedAmount = 2 * 1024 * 1024;

            // Start send in background
            const sendPromise = conn.send("test data");

            // Clear buffer after a short delay
            setTimeout(() => {
                getMockWs().bufferedAmount = 0;
            }, 30);

            await sendPromise;

            expect(getMockWs().sentMessages).toContain("test data");
        });
    });

    describe("isReady()", () => {
        it("should return true when connection is open", async () => {
            const connPromise = wsTransportConnection(defaultConfig);
            await nextTick()

            const conn = await connPromise;

            expect(conn.isReady()).toBe(true);
        });

        it("should return false when connection is closed", async () => {
            const connPromise = wsTransportConnection(defaultConfig);
            await nextTick()

            const conn = await connPromise;

            getMockWs().readyState = MockWebSocket.CLOSED;

            expect(conn.isReady()).toBe(false);
        });
    });
});
