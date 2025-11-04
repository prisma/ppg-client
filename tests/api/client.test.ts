import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ClientConfig, client, defaultClientConfig } from "../../src/api/client.ts";
import { toCollectableIterator } from "../../src/common/types.ts";
import type { BaseTransport } from "../../src/transport/shared.ts";
import type { WebSocketTransport } from "../../src/transport/websocket.ts";

// Mock transport factory functions
vi.mock("../../src/transport/http.ts", () => ({
    httpTransport: vi.fn(),
}));

vi.mock("../../src/transport/websocket.ts", () => ({
    webSocketTransport: vi.fn(),
}));

import { httpTransport } from "../../src/transport/http.ts";
import { webSocketTransport } from "../../src/transport/websocket.ts";

// Helper to create a mock HTTP transport
function createMockHttpTransport(): BaseTransport {
    return {
        statement: vi.fn(),
    } as unknown as BaseTransport;
}

// Helper to create a mock WebSocket transport
function createMockWebSocketTransport(): WebSocketTransport {
    return {
        statement: vi.fn(),
        connect: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
        [Symbol.dispose]: vi.fn(),
    } as unknown as WebSocketTransport;
}

describe("Client API", () => {
    let mockHttpTransport: BaseTransport;
    let mockWsTransport: WebSocketTransport;

    beforeEach(() => {
        vi.clearAllMocks();

        mockHttpTransport = createMockHttpTransport();
        mockWsTransport = createMockWebSocketTransport();

        vi.mocked(httpTransport).mockReturnValue(mockHttpTransport);
        vi.mocked(webSocketTransport).mockReturnValue(mockWsTransport);
    });

    describe("Connection string parsing", () => {
        it("should parse valid postgres:// connection string", () => {
            client({ connectionString: "postgres://user:pass@localhost:5432/mydb" });

            expect(httpTransport).toHaveBeenCalledWith({
                endpoint: "https://localhost",
                username: "user",
                password: "pass",
                database: "mydb",
            });
        });

        it("should parse valid postgresql:// connection string", () => {
            client({ connectionString: "postgresql://user:pass@localhost:5432/mydb" });

            expect(httpTransport).toHaveBeenCalledWith({
                endpoint: "https://localhost",
                username: "user",
                password: "pass",
                database: "mydb",
            });
        });

        it("should parse connection string without database", () => {
            client({ connectionString: "postgres://user:pass@localhost:5432" });

            expect(httpTransport).toHaveBeenCalledWith({
                endpoint: "https://localhost",
                username: "user",
                password: "pass",
                database: undefined,
            });
        });

        it("should throw error for invalid protocol", () => {
            expect(() => {
                client({ connectionString: "mysql://user:pass@localhost:5432/mydb" });
            }).toThrow("Invalid connection string protocol: mysql:");
        });

        it("should throw error for missing username", () => {
            expect(() => {
                client({ connectionString: "postgres://:pass@localhost:5432/mydb" });
            }).toThrow("Connection string must include username and password");
        });

        it("should throw error for missing password", () => {
            expect(() => {
                client({ connectionString: "postgres://user@localhost:5432/mydb" });
            }).toThrow("Connection string must include username and password");
        });

        it("should use transportConfig to override connection string parsing", () => {
            const customConfig = {
                endpoint: "https://custom-host:9999",
                username: "custom-user",
                password: "custom-pass",
                database: "custom-db",
            };

            client({
                connectionString: "postgres://ignored:ignored@ignored:5432/ignored",
                transportConfig: customConfig,
            } as ClientConfig);

            expect(httpTransport).toHaveBeenCalledWith(customConfig);
        });
    });

    describe("query()", () => {
        it("should delegate to HTTP transport and parse results", async () => {
            const mockRows = [["1"], ["2"], ["3"]];
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [{ name: "num", oid: 23 }],
                rows: toCollectableIterator(
                    (async function* () {
                        for (const row of mockRows) {
                            yield row;
                        }
                    })(),
                ),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            const result = await cl.query("SELECT * FROM users");

            expect(mockHttpTransport.statement).toHaveBeenCalledWith("query", "SELECT * FROM users", []);
            expect(result.columns).toEqual([{ name: "num", oid: 23 }]);

            const rows = await result.rows.collect();
            expect(rows).toEqual([{ values: [1] }, { values: [2] }, { values: [3] }]);
        });

        it("should serialize parameters using default serializers", async () => {
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [],
                rows: toCollectableIterator((async function* () {})()),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            const testDate = new Date("2024-01-15T10:30:00Z");
            const bigNum = 9007199254740991n;

            await cl.query("SELECT $1, $2, $3, $4, $5", "text", 42, testDate, bigNum, true);

            expect(mockHttpTransport.statement).toHaveBeenCalledWith("query", "SELECT $1, $2, $3, $4, $5", [
                "text",
                "42",
                "2024-01-15T10:30:00.000Z",
                "9007199254740991",
                "t",
            ]);
        });

        it("should serialize null and undefined parameters as null", async () => {
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [],
                rows: toCollectableIterator((async function* () {})()),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            await cl.query("SELECT $1, $2", null, undefined);

            expect(mockHttpTransport.statement).toHaveBeenCalledWith("query", "SELECT $1, $2", [null, null]);
        });

        it("should use custom serializers when provided", async () => {
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [],
                rows: toCollectableIterator((async function* () {})()),
            });

            const cl = client({
                connectionString: "postgres://user:pass@localhost:5432/mydb",
                serializers: [
                    {
                        supports: (value): value is number => typeof value === "number",
                        serialize: (value: number) => `custom-${value}`,
                    },
                ],
            });

            await cl.query("SELECT $1", 42);

            expect(mockHttpTransport.statement).toHaveBeenCalledWith("query", "SELECT $1", ["custom-42"]);
        });

        it("should use custom parsers when provided", async () => {
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [{ name: "flag", oid: 16 }],
                rows: toCollectableIterator(
                    (async function* () {
                        yield ["t"];
                    })(),
                ),
            });

            const cl = client({
                connectionString: "postgres://user:pass@localhost:5432/mydb",
                parsers: [
                    {
                        oid: 16,
                        parse: (value) => (value === "t" ? "TRUE" : "FALSE"),
                    },
                ],
            });

            const result = await cl.query("SELECT true as flag");
            const rows = await result.rows.collect();

            expect(rows[0].values[0]).toBe("TRUE");
        });

        it("should parse null values correctly", async () => {
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [{ name: "nullable", oid: 25 }],
                rows: toCollectableIterator(
                    (async function* () {
                        yield [null];
                    })(),
                ),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            const result = await cl.query("SELECT NULL as nullable");
            const rows = await result.rows.collect();

            expect(rows[0].values[0]).toBe(null);
        });

        it("should parse JSON/JSONB values", async () => {
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [{ name: "data", oid: 3802 }],
                rows: toCollectableIterator(
                    (async function* () {
                        yield ['{"key": "value"}'];
                    })(),
                ),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            const result = await cl.query("SELECT '{}'::jsonb as data");
            const rows = await result.rows.collect();

            expect(rows[0].values[0]).toEqual({ key: "value" });
        });
    });

    describe("exec()", () => {
        it("should delegate to HTTP transport and return rowsAffected", async () => {
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [{ name: "rowsAffected", oid: 23 }],
                rows: toCollectableIterator(
                    (async function* () {
                        yield ["42"];
                    })(),
                ),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            const affected = await cl.exec("DELETE FROM users WHERE id = $1", "123");

            expect(mockHttpTransport.statement).toHaveBeenCalledWith("exec", "DELETE FROM users WHERE id = $1", [
                "123",
            ]);
            expect(affected).toBe(42);
        });

        it("should serialize parameters correctly", async () => {
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [{ name: "rowsAffected", oid: 23 }],
                rows: toCollectableIterator(
                    (async function* () {
                        yield ["10"];
                    })(),
                ),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            await cl.exec("UPDATE users SET active = $1 WHERE age > $2", true, 18);

            expect(mockHttpTransport.statement).toHaveBeenCalledWith(
                "exec",
                "UPDATE users SET active = $1 WHERE age > $2",
                ["t", "18"],
            );
        });

        it("should throw error if exec response is malformed", async () => {
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [],
                rows: toCollectableIterator((async function* () {})()),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));

            await expect(cl.exec("DELETE FROM users")).rejects.toThrow("Protocol error");
        });
    });

    describe("newSession()", () => {
        it("should create WebSocket transport and call connect()", async () => {
            const mockConnect = vi.fn().mockResolvedValue(undefined);
            mockWsTransport = {
                ...createMockWebSocketTransport(),
                connect: mockConnect,
            } as unknown as WebSocketTransport;
            vi.mocked(webSocketTransport).mockReturnValue(mockWsTransport);

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            await cl.newSession();

            expect(webSocketTransport).toHaveBeenCalledWith({
                endpoint: "https://localhost",
                username: "user",
                password: "pass",
                database: "mydb",
            });
            expect(mockConnect).toHaveBeenCalled();
        });

        it("should create session with query method", async () => {
            const mockConnect = vi.fn().mockResolvedValue(undefined);
            mockWsTransport = {
                ...createMockWebSocketTransport(),
                connect: mockConnect,
            } as unknown as WebSocketTransport;
            vi.mocked(webSocketTransport).mockReturnValue(mockWsTransport);
            vi.mocked(mockWsTransport.statement).mockResolvedValue({
                columns: [{ name: "result", oid: 25 }],
                rows: toCollectableIterator(
                    (async function* () {
                        yield ["session-query"];
                    })(),
                ),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            const session = await cl.newSession();

            const result = await session.query("SELECT 'session-query'");
            const rows = await result.rows.collect();

            expect(mockWsTransport.statement).toHaveBeenCalledWith("query", "SELECT 'session-query'", []);
            expect(rows[0].values[0]).toBe("session-query");
        });

        it("should create session with exec method", async () => {
            const mockConnect = vi.fn().mockResolvedValue(undefined);
            mockWsTransport = {
                ...createMockWebSocketTransport(),
                connect: mockConnect,
            } as unknown as WebSocketTransport;
            vi.mocked(webSocketTransport).mockReturnValue(mockWsTransport);
            vi.mocked(mockWsTransport.statement).mockResolvedValue({
                columns: [{ name: "rowsAffected", oid: 23 }],
                rows: toCollectableIterator(
                    (async function* () {
                        yield ["5"];
                    })(),
                ),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            const session = await cl.newSession();

            const affected = await session.exec("INSERT INTO test VALUES (1), (2), (3), (4), (5)");

            expect(mockWsTransport.statement).toHaveBeenCalledWith(
                "exec",
                "INSERT INTO test VALUES (1), (2), (3), (4), (5)",
                [],
            );
            expect(affected).toBe(5);
        });

        it("should merge session parsers with client parsers", async () => {
            const mockConnect = vi.fn().mockResolvedValue(undefined);
            mockWsTransport = {
                ...createMockWebSocketTransport(),
                connect: mockConnect,
            } as unknown as WebSocketTransport;
            vi.mocked(webSocketTransport).mockReturnValue(mockWsTransport);
            vi.mocked(mockWsTransport.statement).mockResolvedValue({
                columns: [{ name: "flag", oid: 16 }],
                rows: toCollectableIterator(
                    (async function* () {
                        yield ["t"];
                    })(),
                ),
            });

            const cl = client({
                connectionString: "postgres://user:pass@localhost:5432/mydb",
                parsers: [
                    {
                        oid: 16,
                        parse: (value) => (value === "t" ? "CLIENT_TRUE" : "CLIENT_FALSE"),
                    },
                ],
            });

            const session = await cl.newSession({
                parsers: [
                    {
                        oid: 16,
                        parse: (value) => (value === "t" ? "SESSION_TRUE" : "SESSION_FALSE"),
                    },
                ],
            });

            const result = await session.query("SELECT true");
            const rows = await result.rows.collect();

            // Session parser should override client parser
            expect(rows[0].values[0]).toBe("SESSION_TRUE");
        });

        it("should merge session serializers with client serializers", async () => {
            const mockConnect = vi.fn().mockResolvedValue(undefined);
            mockWsTransport = {
                ...createMockWebSocketTransport(),
                connect: mockConnect,
            } as unknown as WebSocketTransport;
            vi.mocked(webSocketTransport).mockReturnValue(mockWsTransport);
            vi.mocked(mockWsTransport.statement).mockResolvedValue({
                columns: [],
                rows: toCollectableIterator((async function* () {})()),
            });

            const cl = client({
                connectionString: "postgres://user:pass@localhost:5432/mydb",
                serializers: [
                    {
                        supports: (value): value is number => typeof value === "number",
                        serialize: (value: number) => `client-${value}`,
                    },
                ],
            });

            const session = await cl.newSession({
                serializers: [
                    {
                        supports: (value): value is number => typeof value === "number",
                        serialize: (value: number) => `session-${value}`,
                    },
                ],
            });

            await session.query("SELECT $1", 42);

            // Session serializer should take precedence
            expect(mockWsTransport.statement).toHaveBeenCalledWith("query", "SELECT $1", ["session-42"]);
        });

        it("should report active state correctly", async () => {
            const mockConnect = vi.fn().mockResolvedValue(undefined);
            const mockIsConnected = vi.fn().mockReturnValue(true);
            mockWsTransport = {
                ...createMockWebSocketTransport(),
                connect: mockConnect,
                isConnected: mockIsConnected,
            } as unknown as WebSocketTransport;
            vi.mocked(webSocketTransport).mockReturnValue(mockWsTransport);

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            const session = await cl.newSession();

            expect(session.active).toBe(true);
            expect(mockIsConnected).toHaveBeenCalled();
        });

        it("should close session and delegate to transport", async () => {
            const mockConnect = vi.fn().mockResolvedValue(undefined);
            const mockClose = vi.fn();
            mockWsTransport = {
                ...createMockWebSocketTransport(),
                connect: mockConnect,
                close: mockClose,
            } as unknown as WebSocketTransport;
            vi.mocked(webSocketTransport).mockReturnValue(mockWsTransport);

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            const session = await cl.newSession();

            session.close();

            expect(mockClose).toHaveBeenCalled();
        });

        it("should support Symbol.dispose for resource cleanup", async () => {
            const mockConnect = vi.fn().mockResolvedValue(undefined);
            const mockClose = vi.fn();
            mockWsTransport = {
                ...createMockWebSocketTransport(),
                connect: mockConnect,
                close: mockClose,
            } as unknown as WebSocketTransport;
            vi.mocked(webSocketTransport).mockReturnValue(mockWsTransport);

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            const session = await cl.newSession();

            session[Symbol.dispose]();

            expect(mockClose).toHaveBeenCalled();
        });
    });

    describe("Default parsers", () => {
        it("should parse boolean (oid 16) correctly", async () => {
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [{ name: "flag", oid: 16 }],
                rows: toCollectableIterator(
                    (async function* () {
                        yield ["t"];
                        yield ["f"];
                    })(),
                ),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            const result = await cl.query("SELECT true, false");
            const rows = await result.rows.collect();

            expect(rows[0].values[0]).toBe(true);
            expect(rows[1].values[0]).toBe(false);
        });

        it("should parse int2 (oid 21) correctly", async () => {
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [{ name: "num", oid: 21 }],
                rows: toCollectableIterator(
                    (async function* () {
                        yield ["42"];
                    })(),
                ),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            const result = await cl.query("SELECT 42::int2");
            const rows = await result.rows.collect();

            expect(rows[0].values[0]).toBe(42);
        });

        it("should parse int4 (oid 23) correctly", async () => {
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [{ name: "num", oid: 23 }],
                rows: toCollectableIterator(
                    (async function* () {
                        yield ["123456"];
                    })(),
                ),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            const result = await cl.query("SELECT 123456::int4");
            const rows = await result.rows.collect();

            expect(rows[0].values[0]).toBe(123456);
        });

        it("should parse int4 (oid 23) null correctly with nullPassThrough", async () => {
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [
                    { name: "num", oid: 23 },
                    { name: "num2", oid: 23 },
                ],
                rows: toCollectableIterator(
                    (async function* () {
                        yield [null, "456"];
                    })(),
                ),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            const result = await cl.query("SELECT NULL::int4, 456::int4");
            const rows = await result.rows.collect();

            // First column should be null (tests the v === null ? null branch)
            expect(rows[0].values[0]).toBe(null);
            // Second column should be parsed as number (tests the fn(v) branch)
            expect(rows[0].values[1]).toBe(456);
        });

        it("should parse int8 (oid 20) as BigInt", async () => {
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [
                    { name: "num", oid: 20 },
                    { name: "num2", oid: 20 },
                ],
                rows: toCollectableIterator(
                    (async function* () {
                        yield ["9007199254740992", null];
                    })(),
                ),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            const result = await cl.query("SELECT 9007199254740992::int8, NULL::int8");
            const rows = await result.rows.collect();

            // Should parse as BigInt to preserve precision
            expect(rows[0].values[0]).toBe(9007199254740992n);
            // Should handle null correctly with nullPassThrough
            expect(rows[0].values[1]).toBe(null);
        });

        it("should parse float4 (oid 700) correctly", async () => {
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [
                    { name: "num", oid: 700 },
                    { name: "num2", oid: 700 },
                ],
                rows: toCollectableIterator(
                    (async function* () {
                        yield ["3.14", null];
                    })(),
                ),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            const result = await cl.query("SELECT 3.14::float4, NULL::float4");
            const rows = await result.rows.collect();

            expect(rows[0].values[0]).toBeCloseTo(3.14);
            expect(rows[0].values[1]).toBe(null);
        });

        it("should parse float8 (oid 701) correctly", async () => {
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [{ name: "num", oid: 701 }],
                rows: toCollectableIterator(
                    (async function* () {
                        yield ["3.141592653589793"];
                    })(),
                ),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            const result = await cl.query("SELECT 3.141592653589793::float8");
            const rows = await result.rows.collect();

            expect(rows[0].values[0]).toBeCloseTo(Math.PI);
        });

        it("should parse text (oid 25) as-is", async () => {
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [{ name: "text", oid: 25 }],
                rows: toCollectableIterator(
                    (async function* () {
                        yield ["hello world"];
                    })(),
                ),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            const result = await cl.query("SELECT 'hello world'::text");
            const rows = await result.rows.collect();

            expect(rows[0].values[0]).toBe("hello world");
        });

        it("should parse varchar (oid 1043) as-is", async () => {
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [{ name: "text", oid: 1043 }],
                rows: toCollectableIterator(
                    (async function* () {
                        yield ["varchar value"];
                    })(),
                ),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            const result = await cl.query("SELECT 'varchar value'::varchar");
            const rows = await result.rows.collect();

            expect(rows[0].values[0]).toBe("varchar value");
        });

        it("should parse json (oid 114) correctly", async () => {
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [{ name: "data", oid: 114 }],
                rows: toCollectableIterator(
                    (async function* () {
                        yield ['{"foo": "bar"}'];
                    })(),
                ),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            const result = await cl.query("SELECT '{}'::json");
            const rows = await result.rows.collect();

            expect(rows[0].values[0]).toEqual({ foo: "bar" });
        });

        it("should return raw string value for unknown OID (parser fallback)", async () => {
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [{ name: "unknown", oid: 99999 }],
                rows: toCollectableIterator(
                    (async function* () {
                        yield ["raw-value"];
                    })(),
                ),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            const result = await cl.query("SELECT 'raw-value'::unknown_type");
            const rows = await result.rows.collect();

            // Should return the raw string value when no parser is found
            expect(rows[0].values[0]).toBe("raw-value");
        });
    });

    describe("Default serializers", () => {
        it("should serialize Date to ISO string", async () => {
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [],
                rows: toCollectableIterator((async function* () {})()),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            const date = new Date("2024-01-15T10:30:00Z");
            await cl.query("SELECT $1", date);

            expect(mockHttpTransport.statement).toHaveBeenCalledWith("query", "SELECT $1", [
                "2024-01-15T10:30:00.000Z",
            ]);
        });

        it("should serialize BigInt to string", async () => {
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [],
                rows: toCollectableIterator((async function* () {})()),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            const bigNum = 9007199254740991n;
            await cl.query("SELECT $1", bigNum);

            expect(mockHttpTransport.statement).toHaveBeenCalledWith("query", "SELECT $1", ["9007199254740991"]);
        });

        it("should serialize boolean to t/f", async () => {
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [],
                rows: toCollectableIterator((async function* () {})()),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            await cl.query("SELECT $1, $2", true, false);

            expect(mockHttpTransport.statement).toHaveBeenCalledWith("query", "SELECT $1, $2", ["t", "f"]);
        });

        it("should serialize number to string", async () => {
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [],
                rows: toCollectableIterator((async function* () {})()),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            await cl.query("SELECT $1, $2", 42, 3.14);

            expect(mockHttpTransport.statement).toHaveBeenCalledWith("query", "SELECT $1, $2", ["42", "3.14"]);
        });

        it("should fall back to String() for unknown types", async () => {
            vi.mocked(mockHttpTransport.statement).mockResolvedValue({
                columns: [],
                rows: toCollectableIterator((async function* () {})()),
            });

            const cl = client(defaultClientConfig("postgres://user:pass@localhost:5432/mydb"));
            const obj = { toString: () => "custom-object" };
            await cl.query("SELECT $1", obj);

            expect(mockHttpTransport.statement).toHaveBeenCalledWith("query", "SELECT $1", ["custom-object"]);
        });
    });
});
