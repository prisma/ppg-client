import type { WebSocketAuthFrame } from "./frames.ts";
import { type QueryQueue, newQueryQueue } from "./query-queue.ts";
import type { TransportConfig } from "./shared.ts";
import { createDeferred, createWebSocket, wsBusyCheck } from "./shims.ts";

export interface WsTransportConnection {
    readonly queryQueue: QueryQueue;
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView<ArrayBufferLike>): Promise<void>;
    isReady(): boolean;
    close(): void;
}

type Timeout = ReturnType<typeof setTimeout>;

const WS_REQUEST_PATH = "/db/websocket";
const WS_SUBPROTOCOL = "prisma-postgres:1.0";
const AUTH_TIMEOUT_MS = 5000;
const MAX_BACKOFF_MS = 100;

export async function wsTransportConnection(config: TransportConfig): Promise<WsTransportConnection> {
    // Construct the WebSocket URL
    const url = new URL(WS_REQUEST_PATH, config.endpoint);
    url.protocol = url.protocol.replace("http", "ws");

    if (config.database) {
        url.searchParams.set("database", config.database);
    }

    // Create WebSocket connection with required subprotocol
    const ws = await createWebSocket(url.toString(), WS_SUBPROTOCOL);
    ws.binaryType = "arraybuffer";

    // Authentication state
    const authDeferred = createDeferred<WsTransportConnection>();
    let authTimeout: Timeout;

    // Query queue tracks response ordering only
    const queryQueue = newQueryQueue();

    // Message parsing state
    let expectingUrn = true;
    let currentUrn: string | null = null;

    // Send authentication frame
    const authFrame: WebSocketAuthFrame = {
        username: config.username,
        password: config.password,
    };

    // Handle connection open
    ws.onopen = () => {
        ws.send(JSON.stringify(authFrame));

        authTimeout = setTimeout(() => {
            authDeferred.reject(new Error("Authentication timeout"));
            ws.close();
        }, AUTH_TIMEOUT_MS);
    };

    // Handle incoming messages
    ws.onmessage = (event) => {
        // First message after sending auth = authentication succeeded
        if (queryQueue.isEmpty()) {
            clearTimeout(authTimeout);
            authDeferred.resolve(conn);
        }

        if (expectingUrn) {
            currentUrn = event.data as string;
            expectingUrn = false;
            return;
        }

        // Parse payload
        const payload = typeof event.data === "string" ? JSON.parse(event.data) : event.data;

        queryQueue.processFrame(currentUrn!, payload);
        currentUrn = null;
        expectingUrn = true;
    };

    // Handle errors
    ws.onerror = (event) => {
        // Extract error message from event if available
        const errorMsg = "message" in event ? String(event.message) : "WebSocket error";
        const error = new Error(errorMsg);

        if (queryQueue.isEmpty()) {
            authDeferred.reject(error);
        } else {
            queryQueue.abortAll(error);
        }
    };

    // Handle connection close
    ws.onclose = (event) => {
        clearTimeout(authTimeout);
        const closeError = new Error(`WebSocket connection closed: ${event.code} - ${event.reason}`);

        if (queryQueue.isEmpty()) {
            authDeferred.reject(closeError);
        } else {
            queryQueue.abortAll(closeError);
        }
    };

    const isBusy = wsBusyCheck(ws);

    const conn: WsTransportConnection = {
        isReady() {
            return ws.readyState === WebSocket.OPEN;
        },
        queryQueue,
        async send(data) {
            let backoffMs = 5;
            while (isBusy()) {
                await new Promise((resolve) => setTimeout(resolve, backoffMs));
                // Exponential backoff: 5ms -> 10ms -> 20ms -> 40ms -> ... -> 100ms
                backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
            }
            ws.send(data);
        },
        close() {
            ws.close(1000, "Normal closure");
        },
    };

    return authDeferred.promise;
}
