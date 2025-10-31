import { type RawParameter } from "../common/types.ts";
import { type RequestFrame, type StatementKind, requestFrames } from "./frames.ts";
import { type BaseTransport, FRAME_URNS, type StatementResponse, type TransportConfig } from "./shared.ts";
import { wsTransportConnection } from "./websocket-conn.ts";

export interface WebSocketTransport extends BaseTransport, AsyncDisposable {
    /**
     * Gracefully closes the current WebSocketTransport.
     * This will not run any implicit transaction command: the database
     * will automatically rollback any pending transaction when
     * closing without commit.
     *
     * This is an alias for [Symbol.asyncDispose]()
     */
    close(): PromiseLike<void>;

    /**
     * Check if the connection is open
     */
    isConnected(): boolean;
}

export async function webSocketTransport(config: TransportConfig): Promise<WebSocketTransport> {
    const conn = await wsTransportConnection(config);

    // Send frames immediately with backpressure detection
    async function sendFrames(frames: RequestFrame[]): Promise<void> {
        for (const frame of frames) {
            if ("query" in frame || "exec" in frame) {
                conn.send(FRAME_URNS.queryDescriptorUrn);
                conn.send(JSON.stringify(frame));
            } else {
                // ExtendedParamFrame
                const extendedParam = frame;

                if (extendedParam.type === "text") {
                    conn.send(FRAME_URNS.textParamUrn);

                    if (typeof extendedParam.data === "string") {
                        conn.send(extendedParam.data);
                    } else if (extendedParam.data instanceof Uint8Array) {
                        conn.send(extendedParam.data);
                    } else if (extendedParam.data instanceof ReadableStream) {
                        throw new Error("ReadableStream parameters not yet supported for WebSocket transport");
                    }
                } else {
                    conn.send(FRAME_URNS.binaryParamUrn);

                    if (extendedParam.data instanceof Uint8Array) {
                        conn.send(extendedParam.data);
                    } else if (extendedParam.data instanceof ReadableStream) {
                        throw new Error("ReadableStream parameters not yet supported for WebSocket transport");
                    }
                }
            }
        }
    }

    // Create the transport interface
    const transport: WebSocketTransport = {
        async statement(kind: StatementKind, sql: string, parameters: RawParameter[]): Promise<StatementResponse> {
            if (!conn.isReady()) {
                throw new Error("WebSocket is not connected");
            }

            const frames = await requestFrames(kind, sql, parameters);

            // Enqueue query and get promise for the complete response
            const enqueuedQuery = conn.queryQueue.enqueueNew();

            // Send frames immediately (with backpressure handling)
            sendFrames(frames).catch(enqueuedQuery.abort);

            return enqueuedQuery.promise;
        },

        async close() {
            conn.close();
        },

        isConnected() {
            return conn.isReady();
        },

        async [Symbol.asyncDispose]() {
            await this.close();
        },
    };

    return transport;
}
