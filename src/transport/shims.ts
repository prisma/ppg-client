import { GenericError } from "../common/types.ts";

/**
 * A deferred promise that exposes its resolve and reject functions.
 * Uses Promise.withResolvers() when available (ES2024+).
 */
export interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
}

export async function* emptyIterableIterator<T>(): AsyncIterableIterator<T> {
    // no yield → immediately done
}

/**
 * Creates a deferred promise with exposed resolve/reject functions.
 * Uses native Promise.withResolvers() when available.
 */
export function createDeferred<T>(): Deferred<T> {
    // Use native Promise.withResolvers if available (ES2024+)
    if ("withResolvers" in Promise && typeof Promise.withResolvers === "function") {
        return Promise.withResolvers();
    }

    // Polyfill for older environments
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return { promise, resolve, reject };
}

/**
 * WebSocket factory that uses native WebSocket when available,
 * and falls back to 'ws' library for Node.js environments without native support.
 *
 * @param url - WebSocket URL
 * @param protocols - Optional protocol or array of protocols
 * @returns WebSocket instance
 */
export async function createWebSocket(url: string | URL, protocols?: string | string[]): Promise<WebSocket> {
    // Check if native WebSocket is available (browsers, Deno, Node 21+)
    if (typeof WebSocket !== "undefined") {
        return new WebSocket(url, protocols);
    }

    // Fall back to 'ws' library for Node.js < 21
    try {
        const WS = await import("ws");
        const WebSocketImpl = WS.WebSocket || WS.default;
        return new WebSocketImpl(url, protocols) as unknown as WebSocket;
    } catch (error) {
        throw new GenericError(
            'WebSocket is not available. For Node.js < 21, please install the "ws" package: npm install ws',
            { cause: error },
        );
    }
}

const MAX_BUFFERED_AMOUNT = 1024 * 1024; // 1MB buffer threshold

export function wsBusyCheck(ws: WebSocket) {
    return "bufferedAmount" in ws && typeof ws.bufferedAmount === "number"
        ? () => ws.bufferedAmount > MAX_BUFFERED_AMOUNT
        : () => false;
}

const hasBufferByteLength = typeof Buffer !== "undefined" && typeof Buffer.byteLength === "function";

export function utf8ByteLength(str: string): number {
    if (hasBufferByteLength) {
        return Buffer.byteLength(str, "utf8");
    }

    // the following should be more memory efficient than using TextEncoder, then throwing the result away 😅
    let bytes = 0;
    for (let i = 0; i < str.length; i++) {
        let codePoint = str.charCodeAt(i);

        // Handle surrogate pairs (UTF-16)
        if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
            const next = str.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                // Combine surrogate pair into full code point
                codePoint = ((codePoint - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
                i++; // Skip the next surrogate
            }
        }

        if (codePoint <= 0x7f) {
            bytes += 1;
        } else if (codePoint <= 0x7ff) {
            bytes += 2;
        } else if (codePoint <= 0xffff) {
            bytes += 3;
        } else {
            bytes += 4;
        }
    }
    return bytes;
}
