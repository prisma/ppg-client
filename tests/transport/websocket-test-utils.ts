const arrayBufferType: BinaryType = "arraybuffer";

/**
 * Mock WebSocket implementation for testing
 */
export class MockWebSocket implements WebSocket {
    static CONNECTING = 0 as const;
    static OPEN = 1 as const;
    static CLOSING = 2 as const;
    static CLOSED = 3 as const;

    extensions = "";
    CONNECTING = MockWebSocket.CONNECTING;
    OPEN = MockWebSocket.OPEN;
    CLOSING = MockWebSocket.CLOSING;
    CLOSED = MockWebSocket.CLOSED;

    readyState: number = MockWebSocket.CONNECTING;
    binaryType = arrayBufferType;
    url: string;
    protocol: string;

    onclose: ((ev: WebSocketEventMap["close"]) => void) | null = null;
    onerror: ((ev: WebSocketEventMap["error"]) => void) | null = null;
    onmessage: ((ev: WebSocketEventMap["message"]) => void) | null = null;
    onopen: ((ev: WebSocketEventMap["open"]) => void) | null = null;

    sentMessages: unknown[] = [];
    bufferedAmount = 0;

    constructor(url: string | URL, protocols?: string | string[]) {
        this.url = url.toString();
        this.protocol = typeof protocols === "string" ? protocols : protocols ? protocols[0] : "";

        // Simulate async connection
        setTimeout(() => {
            this.readyState = MockWebSocket.OPEN;
            if (this.onopen) {
                this.onopen({ type: "open" } as Event);
            }
        }, 0);
    }
    addEventListener(type: unknown, listener: unknown, options?: unknown): void {
        throw new Error("Method not implemented.");
    }
    removeEventListener(type: unknown, listener: unknown, options?: unknown): void {
        throw new Error("Method not implemented.");
    }
    dispatchEvent(event: Event): boolean {
        throw new Error("Method not implemented.");
    }

    send(data: unknown) {
        this.sentMessages.push(data);
    }

    close(code?: number, reason?: string) {
        this.readyState = MockWebSocket.CLOSED;
        if (this.onclose) {
            this.onclose({ type: "close", code: code ?? 1000, reason: reason ?? "" } as CloseEvent);
        }
    }

    // Test helper methods
    simulateMessage(data: unknown) {
        if (this.onmessage) {
            this.onmessage({ type: "message", data } as MessageEvent);
        }
    }

    simulateError(message: string) {
        if (this.onerror) {
            this.onerror({ type: "error", message } as ErrorEvent);
        }
    }

    simulateClose(code: number, reason: string) {
        this.readyState = MockWebSocket.CLOSED;
        if (this.onclose) {
            this.onclose({ type: "close", code, reason } as CloseEvent);
        }
    }
}

export function runEventLoop() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Creates a mock setup for testing WebSocket connections
 * Returns the current mock instance for test assertions
 */
export function createMockWebSocketSetup() {
    let currentMockWs: MockWebSocket | null = null;

    const mockFactory = async (url: string, protocol: string) => {
        currentMockWs = new MockWebSocket(url, protocol);
        return currentMockWs;
    };

    const getMockWs = () => {
        if (!currentMockWs) throw new Error("MockWebSocket not created yet");
        return currentMockWs;
    };

    const reset = () => {
        currentMockWs = null;
    };

    return {
        mockFactory,
        getMockWs,
        reset,
    };
}
