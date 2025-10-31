/**
 * Mock WebSocket implementation for testing
 */
export class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState: number = MockWebSocket.CONNECTING;
    binaryType: string = "blob";
    url: string;
    protocol: string;

    onopen: ((event: any) => void) | null = null;
    onmessage: ((event: any) => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    onclose: ((event: any) => void) | null = null;

    sentMessages: any[] = [];
    bufferedAmount: number = 0;

    constructor(url: string, protocol: string) {
        this.url = url;
        this.protocol = protocol;

        // Simulate async connection
        setTimeout(() => {
            this.readyState = MockWebSocket.OPEN;
            if (this.onopen) {
                this.onopen({ type: "open" });
            }
        }, 0);
    }

    send(data: any) {
        this.sentMessages.push(data);
    }

    close(code?: number, reason?: string) {
        this.readyState = MockWebSocket.CLOSED;
        if (this.onclose) {
            this.onclose({ type: "close", code: code ?? 1000, reason: reason ?? "" });
        }
    }

    // Test helper methods
    simulateMessage(data: any) {
        if (this.onmessage) {
            this.onmessage({ type: "message", data });
        }
    }

    simulateError(message: string) {
        if (this.onerror) {
            this.onerror({ type: "error", message });
        }
    }

    simulateClose(code: number, reason: string) {
        this.readyState = MockWebSocket.CLOSED;
        if (this.onclose) {
            this.onclose({ type: "close", code, reason });
        }
    }
}

export function nextTick() {
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
