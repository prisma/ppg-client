import { type RawParameter, ValidationError, WebSocketError } from "../common/types.ts";
import { type RequestFrame, type StatementKind, requestFrames } from "./frames.ts";
import { type BaseTransport, FRAME_URNS, type StatementResponse, type TransportConfig } from "./shared.ts";
import { type WsTransportConnection, wsTransportConnection } from "./websocket-conn.ts";

export interface WebSocketTransport extends BaseTransport, Disposable {
    /**
     * Establishes the WebSocket connection to the database.
     * This must be called before executing any statements.
     * Subsequent calls to connect() are no-ops if already connected.
     */
    connect(): Promise<void>;

    /**
     * Gracefully closes the current WebSocketTransport.
     * This will not run any implicit transaction command: the database
     * will rollback any pending transaction when closing without commit.
     *
     * This is an alias for [Symbol.dispose]()
     */
    close(): void;

    /**
     * Check if the connection is open
     */
    isConnected(): boolean;
}

export function webSocketTransport(config: TransportConfig): WebSocketTransport {
    let conn: WsTransportConnection | undefined;

    // Queue to ensure sequential frame sending (prevent interleaving of concurrent requests)
    let sendQueue = Promise.resolve();

    // Create the transport interface
    const transport: WebSocketTransport = {
        async connect() {
            conn ??= await wsTransportConnection(config);
        },
        async statement(kind: StatementKind, sql: string, parameters: RawParameter[]): Promise<StatementResponse> {
            if (!conn?.isReady()) {
                throw new WebSocketError({ message: "WebSocket is not connected" });
            }

            // Prepare the request frames
            const frames = await requestFrames(kind, sql, parameters);

            // Enqueue query and get promise for the complete response.
            // Results arrive in a FIFO order, so this enqueued query will
            // match the rquest frames we're about to send.
            const enqueuedQuery = conn.enqueueNewQuery();

            const activeConn = conn;

            // Chain this send operation to the queue to ensure sequential execution...
            sendQueue = sendQueue.then(() => sendFrames(activeConn, frames)).catch(enqueuedQuery.abort); // abort makes all enqueuedQuery promises reject.

            // ...and wait for it to complete (so it blocks on backpressure)
            await sendQueue;

            // This promise resolves when results from the related enqueued query start arriving
            return enqueuedQuery.promise;
        },

        close() {
            conn?.close();
        },

        isConnected() {
            return !!conn?.isReady();
        },

        [Symbol.dispose]() {
            this.close();
        },
    };

    return transport;
}

/**
 * Send frames immediately with backpressure detection
 * @param conn
 * @param frames
 */
async function sendFrames(conn: WsTransportConnection, frames: RequestFrame[]): Promise<void> {
    for (const frame of frames) {
        if ("query" in frame || "exec" in frame) {
            await conn.send(FRAME_URNS.queryDescriptorUrn);
            await conn.send(JSON.stringify(frame));
        } else {
            // ExtendedParamFrame
            const isTextParam = frame.type === "text";

            await conn.send(isTextParam ? FRAME_URNS.textParamUrn : FRAME_URNS.binaryParamUrn);

            if (typeof frame.data === "string") {
                await conn.send(frame.data);
            } else if (frame.data instanceof Uint8Array) {
                await conn.send(frame.data);
            } else if (frame.data instanceof ReadableStream) {
                if (isTextParam) {
                    // Consume the stream and decode to string
                    const text = await consumeStreamToString(frame.data);
                    await conn.send(text);
                } else {
                    // Consume the stream into a Uint8Array
                    const bytes = await consumeStreamToUint8Array(frame.data);
                    await conn.send(bytes);
                }
            } else {
                throw new ValidationError(`Unsupported extended parameter data type: ${typeof frame.data}`);
            }
        }
    }
}

/**
 * Consume a ReadableStream<Uint8Array> into a single Uint8Array
 */
async function consumeStreamToUint8Array(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let totalLength = 0;

    const reader = stream.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            totalLength += value.length;
        }
    } finally {
        reader.releaseLock();
    }

    // Combine all chunks into a single Uint8Array
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return result;
}

/**
 * Decode a ReadableStream<Uint8Array> to a string using TextDecoder
 */
async function consumeStreamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
    const decoder = new TextDecoder();
    let result = "";

    const reader = stream.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            result += decoder.decode(value, { stream: true });
        }
        // Final decode with stream: false to flush any pending bytes
        result += decoder.decode();
    } finally {
        reader.releaseLock();
    }
    return result;
}
