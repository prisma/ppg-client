import { WebSocketError } from "../common/types.ts";
import type { WebSocketAuthFrame } from "./frames.ts";
import { type EnqueuedQuery, newQueryQueue } from "./query-queue.ts";
import type { TransportConfig } from "./shared.ts";
import { createDeferred, createWebSocket, wsBusyCheck } from "./shims.ts";

export interface WsTransportConnection {
    enqueueNewQuery(): EnqueuedQuery;
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView<ArrayBufferLike>): Promise<void>;
    isReady(): boolean;
    close(): void;
}

const WS_REQUEST_PATH = "/db/websocket";
const WS_SUBPROTOCOL = "prisma-postgres-1.0";
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
        authDeferred.resolve(conn);
    };

    // Handle incoming messages
    ws.onmessage = (event) => {
        // Validate that we only receive text messages (not binary)
        if (typeof event.data !== "string") {
            const error = new Error(`Protocol error: expected text message, received ${typeof event.data}`);
            queryQueue.abortAll(error);
            ws.close(1002, "Protocol error: binary messages not supported");
            return;
        }

        if (expectingUrn) {
            currentUrn = event.data;
            expectingUrn = false;
            return;
        }

        // Parse payload (we know it's a string from the check above)
        const payload = JSON.parse(event.data);

        queryQueue.processFrame(currentUrn!, payload);
        currentUrn = null;
        expectingUrn = true;
    };

    // Handle errors
    ws.onerror = (event) => {
        // Extract error message from event if available
        const errorMsg = "message" in event ? String(event.message) : "WebSocket error";
        const error = new WebSocketError({ message: errorMsg });

        authDeferred.reject(error);
        queryQueue.abortAll(error);
    };

    // Handle connection close
    ws.onclose = (event) => {
        authDeferred.resolve(conn);
        const err = new WebSocketError({
            message: "WebSocket connection closed",
            closureCode: event.code,
            closureReason: event.reason,
        });

        if (queryQueue.isEmpty()) {
            authDeferred.reject(err);
        } else {
            queryQueue.abortAll(err);
        }
    };

    const isBusy = wsBusyCheck(ws);

    const conn: WsTransportConnection = {
        isReady() {
            return ws.readyState === WebSocket.OPEN;
        },
        enqueueNewQuery() {
            return queryQueue.enqueueNew();
        },
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
