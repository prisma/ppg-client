import { beforeEach, describe, expect, it, vi } from "vitest";
import { prismaPostgres } from "../../src/api/ppg.ts";
import { toCollectableIterator } from "../../src/common/types.ts";
import type { Client, Session } from "../../src/api/client.ts";

// Mock the client module
vi.mock("../../src/api/client.ts", async () => {
    const actual = await vi.importActual("../../src/api/client.ts");
    return {
        ...actual,
        client: vi.fn(),
    };
});

import { client } from "../../src/api/client.ts";

// Helper to create a mock Client
function createMockClient() {
    return {
        query: vi.fn(),
        exec: vi.fn(),
        newSession: vi.fn(),
    } as Client;
}

// Helper to create a mock Session
function createMockSession() {
    return {
        query: vi.fn(),
        exec: vi.fn(),
        close: vi.fn(),
        active: true,
        [Symbol.dispose]: vi.fn(),
    } as Session;
}

describe("PrismaPostgres API", () => {
    let mockClient: Client;
    let mockSession: Session;

    beforeEach(() => {
        vi.clearAllMocks();

        mockClient = createMockClient();
        mockSession = createMockSession();

        vi.mocked(client).mockReturnValue(mockClient);
        vi.mocked(mockClient.newSession).mockResolvedValue(mockSession);
    });

    describe("Configuration", () => {
        it("should create prismaPostgres client with connection string", () => {
            prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });

            expect(client).toHaveBeenCalledWith({
                connectionString: "postgres://user:pass@localhost:5432/mydb",
            });
        });

        it("should pass parsers and serializers to underlying client", () => {
            const customParser = { oid: 999, parse: (v: string | null) => v };
            const customSerializer = {
                supports: (v: unknown): v is string => typeof v === "string",
                serialize: (v: string) => v,
            };

            prismaPostgres({
                connectionString: "postgres://user:pass@localhost:5432/mydb",
                parsers: [customParser],
                serializers: [customSerializer],
            });

            expect(client).toHaveBeenCalledWith({
                connectionString: "postgres://user:pass@localhost:5432/mydb",
                parsers: [customParser],
                serializers: [customSerializer],
            });
        });
    });

    describe("sql template tag", () => {
        it("should execute sql template query and return objects with column names", async () => {
            vi.mocked(mockClient.query).mockImplementation(async () => {
                const columns = [
                    { name: "id", oid: 23 },
                    { name: "name", oid: 25 },
                ];
                const mockRows = [
                    { values: ["1", "Alice"] },
                    { values: ["2", "Bob"] },
                ];

                return {
                    columns,
                    rows: toCollectableIterator(
                        (async function* () {
                            for (const row of mockRows) {
                                yield row;
                            }
                        })(),
                    ),
                };
            });

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });
            const userId = 1;
            const rows = await ppg.sql<{ id: string; name: string }>`SELECT id, name FROM users WHERE id > ${userId}`.collect();

            expect(mockClient.query).toHaveBeenCalledWith("SELECT id, name FROM users WHERE id > $1", 1);
            expect(rows).toEqual([
                { id: "1", name: "Alice" },
                { id: "2", name: "Bob" },
            ]);
        });

        it("should support streaming iteration with sql template", async () => {
            vi.mocked(mockClient.query).mockResolvedValue({
                columns: [{ name: "n", oid: 23 }],
                rows: toCollectableIterator(
                    (async function* () {
                        yield { values: ["1"] };
                        yield { values: ["2"] };
                        yield { values: ["3"] };
                    })(),
                ),
            });

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });
            const iterator = ppg.sql<{ n: string }>`SELECT generate_series(1, 3) as n`;

            const collected: { n: string }[] = [];
            for await (const row of iterator) {
                collected.push(row);
            }

            expect(collected).toEqual([{ n: "1" }, { n: "2" }, { n: "3" }]);
        });

        it("should handle multiple parameters in sql template", async () => {
            vi.mocked(mockClient.query).mockResolvedValue({
                columns: [{ name: "result", oid: 25 }],
                rows: toCollectableIterator(
                    (async function* () {
                        yield { values: ["matched"] };
                    })(),
                ),
            });

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });
            const name = "Alice";
            const age = 30;
            const active = true;

            await ppg.sql<{ result: string }>`SELECT * FROM users WHERE name = ${name} AND age = ${age} AND active = ${active}`.collect();

            expect(mockClient.query).toHaveBeenCalledWith(
                "SELECT * FROM users WHERE name = $1 AND age = $2 AND active = $3",
                "Alice",
                30,
                true,
            );
        });

        it("should handle sql template with no parameters", async () => {
            vi.mocked(mockClient.query).mockResolvedValue({
                columns: [{ name: "count", oid: 23 }],
                rows: toCollectableIterator(
                    (async function* () {
                        yield { values: ["5"] };
                    })(),
                ),
            });

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });
            await ppg.sql<{ count: string }>`SELECT COUNT(*) as count FROM users`.collect();

            expect(mockClient.query).toHaveBeenCalledWith("SELECT COUNT(*) as count FROM users");
        });
    });

    describe("sql.exec template tag", () => {
        it("should execute sql.exec template and return affected count", async () => {
            vi.mocked(mockClient.exec).mockResolvedValue(3);

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });
            const userId = 42;
            const affected = await ppg.sql.exec`DELETE FROM users WHERE id = ${userId}`;

            expect(mockClient.exec).toHaveBeenCalledWith("DELETE FROM users WHERE id = $1", 42);
            expect(affected).toBe(3);
        });

        it("should handle sql.exec with multiple parameters", async () => {
            vi.mocked(mockClient.exec).mockResolvedValue(1);

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });
            const id = 1;
            const name = "Updated";
            const affected = await ppg.sql.exec`UPDATE users SET name = ${name} WHERE id = ${id}`;

            expect(mockClient.exec).toHaveBeenCalledWith("UPDATE users SET name = $1 WHERE id = $2", "Updated", 1);
            expect(affected).toBe(1);
        });
    });

    describe("query()", () => {
        it("should execute raw query and return objects with column names", async () => {
            vi.mocked(mockClient.query).mockResolvedValue({
                columns: [
                    { name: "id", oid: 23 },
                    { name: "name", oid: 25 },
                ],
                rows: toCollectableIterator(
                    (async function* () {
                        yield { values: ["1", "Alice"] };
                    })(),
                ),
            });

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });
            const rows = await ppg.query<{ id: string; name: string }>("SELECT id, name FROM users WHERE id = $1", 1).collect();

            expect(mockClient.query).toHaveBeenCalledWith("SELECT id, name FROM users WHERE id = $1", 1);
            expect(rows).toEqual([{ id: "1", name: "Alice" }]);
        });

        it("should support streaming iteration with query()", async () => {
            vi.mocked(mockClient.query).mockResolvedValue({
                columns: [{ name: "n", oid: 23 }],
                rows: toCollectableIterator(
                    (async function* () {
                        yield { values: ["1"] };
                        yield { values: ["2"] };
                    })(),
                ),
            });

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });
            const iterator = ppg.query<{ n: string }>("SELECT generate_series(1, 2) as n");

            const collected: { n: string }[] = [];
            for await (const row of iterator) {
                collected.push(row);
            }

            expect(collected).toEqual([{ n: "1" }, { n: "2" }]);
        });

        it("should handle query with multiple parameters", async () => {
            vi.mocked(mockClient.query).mockResolvedValue({
                columns: [{ name: "result", oid: 25 }],
                rows: toCollectableIterator(
                    (async function* () {
                        yield { values: ["matched"] };
                    })(),
                ),
            });

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });
            await ppg.query<{ result: string }>("SELECT * FROM users WHERE name = $1 AND age = $2", "Alice", 30).collect();

            expect(mockClient.query).toHaveBeenCalledWith("SELECT * FROM users WHERE name = $1 AND age = $2", "Alice", 30);
        });
    });

    describe("exec()", () => {
        it("should execute raw exec and return affected count", async () => {
            vi.mocked(mockClient.exec).mockResolvedValue(5);

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });
            const affected = await ppg.exec("DELETE FROM users WHERE age > $1", 100);

            expect(mockClient.exec).toHaveBeenCalledWith("DELETE FROM users WHERE age > $1", 100);
            expect(affected).toBe(5);
        });

        it("should handle exec with no parameters", async () => {
            vi.mocked(mockClient.exec).mockResolvedValue(0);

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });
            const affected = await ppg.exec("TRUNCATE TABLE users");

            expect(mockClient.exec).toHaveBeenCalledWith("TRUNCATE TABLE users");
            expect(affected).toBe(0);
        });
    });

    describe("transaction()", () => {
        it("should execute transaction with BEGIN/COMMIT", async () => {
            vi.mocked(mockSession.exec).mockResolvedValue(0);
            vi.mocked(mockSession.query).mockResolvedValue({
                columns: [{ name: "id", oid: 23 }],
                rows: toCollectableIterator(
                    (async function* () {
                        yield { values: ["1"] };
                    })(),
                ),
            });

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });

            const result = await ppg.transaction(async (tx) => {
                await tx.sql.exec`INSERT INTO users VALUES (${1}, ${"Alice"})`;
                return "success";
            });

            expect(mockClient.newSession).toHaveBeenCalled();
            expect(mockSession.exec).toHaveBeenCalledWith("BEGIN");
            expect(mockSession.exec).toHaveBeenCalledWith("INSERT INTO users VALUES ($1, $2)", 1, "Alice");
            expect(mockSession.exec).toHaveBeenCalledWith("COMMIT");
            expect(result).toBe("success");
        });

        it("should execute ROLLBACK on error and rethrow", async () => {
            vi.mocked(mockSession.exec).mockResolvedValue(0);

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });
            const testError = new Error("Transaction failed");

            await expect(
                ppg.transaction(async (tx) => {
                    await tx.sql.exec`INSERT INTO users VALUES (${1}, ${"Alice"})`;
                    throw testError;
                }),
            ).rejects.toThrow("Transaction failed");

            expect(mockSession.exec).toHaveBeenCalledWith("BEGIN");
            expect(mockSession.exec).toHaveBeenCalledWith("ROLLBACK");
            expect(mockSession.exec).not.toHaveBeenCalledWith("COMMIT");
        });

        it("should support all statement methods in transaction", async () => {
            vi.mocked(mockSession.exec).mockResolvedValue(1);
            vi.mocked(mockSession.query)
                .mockResolvedValueOnce({
                    columns: [{ name: "id", oid: 23 }, { name: "name", oid: 25 }],
                    rows: toCollectableIterator(
                        (async function* () {
                            yield { values: ["1", "Alice"] };
                        })(),
                    ),
                })
                .mockResolvedValueOnce({
                    columns: [{ name: "id", oid: 23 }, { name: "name", oid: 25 }],
                    rows: toCollectableIterator(
                        (async function* () {
                            yield { values: ["2", "Bob"] };
                        })(),
                    ),
                });

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });

            await ppg.transaction(async (tx) => {
                // sql template query
                const users1 = await tx.sql<{ id: string; name: string }>`SELECT * FROM users`.collect();
                expect(users1).toEqual([{ id: "1", name: "Alice" }]);

                // sql.exec template
                await tx.sql.exec`INSERT INTO users VALUES (${2}, ${"Bob"})`;

                // raw query
                const users2 = await tx.query<{ id: string; name: string }>("SELECT * FROM users WHERE id = $1", 2).collect();
                expect(users2).toEqual([{ id: "2", name: "Bob" }]);

                // raw exec
                await tx.exec("DELETE FROM users WHERE id = $1", 2);
            });

            expect(mockSession.exec).toHaveBeenCalledWith("BEGIN");
            expect(mockSession.exec).toHaveBeenCalledWith("COMMIT");
        });

        it("should dispose session after transaction", async () => {
            vi.mocked(mockSession.exec).mockResolvedValue(0);

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });

            await ppg.transaction(async () => {
                // empty transaction
            });

            // Session should be disposed via using declaration
            expect(mockSession[Symbol.dispose]).toHaveBeenCalled();
        });
    });

    describe("batch() with array syntax", () => {
        it("should execute batch with query statements", async () => {
            vi.mocked(mockSession.exec).mockResolvedValue(0);
            vi.mocked(mockSession.query)
                .mockResolvedValueOnce({
                    columns: [{ name: "id", oid: 23 }],
                    rows: toCollectableIterator(
                        (async function* () {
                            yield { values: ["1"] };
                            yield { values: ["2"] };
                        })(),
                    ),
                })
                .mockResolvedValueOnce({
                    columns: [{ name: "count", oid: 23 }],
                    rows: toCollectableIterator(
                        (async function* () {
                            yield { values: ["2"] };
                        })(),
                    ),
                });

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });

            const [users, counts] = await ppg.batch<[{ id: string }[], { count: string }[]]>(
                { query: "SELECT id FROM users WHERE id < $1", parameters: [10] },
                { query: "SELECT COUNT(*) as count FROM users", parameters: [] },
            );

            expect(users).toEqual([{ id: "1" }, { id: "2" }]);
            expect(counts).toEqual([{ count: "2" }]);
            expect(mockSession.query).toHaveBeenCalledWith("SELECT id FROM users WHERE id < $1", 10);
            expect(mockSession.query).toHaveBeenCalledWith("SELECT COUNT(*) as count FROM users");
        });

        it("should execute batch with exec statements", async () => {
            vi.mocked(mockSession.exec)
                .mockResolvedValueOnce(0) // BEGIN
                .mockResolvedValueOnce(1) // First INSERT
                .mockResolvedValueOnce(2) // Second INSERT
                .mockResolvedValueOnce(0); // COMMIT

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });

            const [affected1, affected2] = await ppg.batch<[number, number]>(
                { exec: "INSERT INTO users VALUES ($1, $2)", parameters: [1, "Alice"] },
                { exec: "INSERT INTO users VALUES ($1, $2), ($3, $4)", parameters: [2, "Bob", 3, "Charlie"] },
            );

            expect(affected1).toBe(1);
            expect(affected2).toBe(2);
            expect(mockSession.exec).toHaveBeenCalledWith("INSERT INTO users VALUES ($1, $2)", 1, "Alice");
            expect(mockSession.exec).toHaveBeenCalledWith("INSERT INTO users VALUES ($1, $2), ($3, $4)", 2, "Bob", 3, "Charlie");
        });

        it("should execute batch with mixed query and exec statements", async () => {
            vi.mocked(mockSession.exec)
                .mockResolvedValueOnce(0) // BEGIN
                .mockResolvedValueOnce(3) // DELETE
                .mockResolvedValueOnce(0); // COMMIT

            vi.mocked(mockSession.query).mockResolvedValue({
                columns: [{ name: "id", oid: 23 }],
                rows: toCollectableIterator(
                    (async function* () {
                        yield { values: ["1"] };
                    })(),
                ),
            });

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });

            const [users, affected] = await ppg.batch<[{ id: string }[], number]>(
                { query: "SELECT id FROM users WHERE id = $1", parameters: [1] },
                { exec: "DELETE FROM users WHERE id > $1", parameters: [100] },
            );

            expect(users).toEqual([{ id: "1" }]);
            expect(affected).toBe(3);
        });

        it("should rollback batch on error", async () => {
            vi.mocked(mockSession.exec)
                .mockResolvedValueOnce(0) // BEGIN
                .mockResolvedValueOnce(1) // First INSERT
                .mockRejectedValueOnce(new Error("Constraint violation")) // Second INSERT fails
                .mockResolvedValueOnce(0); // ROLLBACK

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });

            await expect(
                ppg.batch<[number, number]>(
                    { exec: "INSERT INTO users VALUES ($1, $2)", parameters: [1, "Alice"] },
                    { exec: "INSERT INTO users VALUES ($1, $2)", parameters: [1, "Alice"] }, // duplicate key
                ),
            ).rejects.toThrow("Constraint violation");

            expect(mockSession.exec).toHaveBeenCalledWith("BEGIN");
            expect(mockSession.exec).toHaveBeenCalledWith("ROLLBACK");
            expect(mockSession.exec).not.toHaveBeenCalledWith("COMMIT");
        });

        it("should handle batch with empty parameters", async () => {
            vi.mocked(mockSession.exec)
                .mockResolvedValueOnce(0) // BEGIN
                .mockResolvedValueOnce(0) // TRUNCATE
                .mockResolvedValueOnce(0); // COMMIT

            vi.mocked(mockSession.query).mockResolvedValue({
                columns: [{ name: "count", oid: 23 }],
                rows: toCollectableIterator(
                    (async function* () {
                        yield { values: ["0"] };
                    })(),
                ),
            });

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });

            const [affected, counts] = await ppg.batch<[number, { count: string }[]]>(
                { exec: "TRUNCATE TABLE users" },
                { query: "SELECT COUNT(*) as count FROM users" },
            );

            expect(affected).toBe(0);
            expect(counts).toEqual([{ count: "0" }]);
            expect(mockSession.exec).toHaveBeenCalledWith("TRUNCATE TABLE users");
            expect(mockSession.query).toHaveBeenCalledWith("SELECT COUNT(*) as count FROM users");
        });
    });

    describe("batch() with fluent builder", () => {
        it("should build and execute batch with query methods", async () => {
            vi.mocked(mockSession.exec).mockResolvedValue(0);
            vi.mocked(mockSession.query)
                .mockResolvedValueOnce({
                    columns: [{ name: "id", oid: 23 }],
                    rows: toCollectableIterator(
                        (async function* () {
                            yield { values: ["1"] };
                        })(),
                    ),
                })
                .mockResolvedValueOnce({
                    columns: [{ name: "name", oid: 25 }],
                    rows: toCollectableIterator(
                        (async function* () {
                            yield { values: ["Alice"] };
                        })(),
                    ),
                });

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });

            const [ids, names] = await ppg
                .batch()
                .query<{ id: string }>("SELECT id FROM users WHERE id = $1", 1)
                .query<{ name: string }>("SELECT name FROM users WHERE id = $1", 1)
                .run();

            expect(ids).toEqual([{ id: "1" }]);
            expect(names).toEqual([{ name: "Alice" }]);
        });

        it("should build and execute batch with exec methods", async () => {
            vi.mocked(mockSession.exec)
                .mockResolvedValueOnce(0) // BEGIN
                .mockResolvedValueOnce(1) // First INSERT
                .mockResolvedValueOnce(1) // Second INSERT
                .mockResolvedValueOnce(0); // COMMIT

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });

            const [affected1, affected2] = await ppg
                .batch()
                .exec("INSERT INTO users VALUES ($1, $2)", 1, "Alice")
                .exec("INSERT INTO users VALUES ($1, $2)", 2, "Bob")
                .run();

            expect(affected1).toBe(1);
            expect(affected2).toBe(1);
        });

        it("should build and execute batch with mixed query and exec", async () => {
            vi.mocked(mockSession.exec)
                .mockResolvedValueOnce(0) // BEGIN
                .mockResolvedValueOnce(1) // INSERT
                .mockResolvedValueOnce(2) // UPDATE
                .mockResolvedValueOnce(0); // COMMIT

            vi.mocked(mockSession.query).mockResolvedValue({
                columns: [{ name: "id", oid: 23 }],
                rows: toCollectableIterator(
                    (async function* () {
                        yield { values: ["1"] };
                    })(),
                ),
            });

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });

            const [inserted, users, updated] = await ppg
                .batch()
                .exec("INSERT INTO users VALUES ($1, $2)", 1, "Alice")
                .query<{ id: string }>("SELECT id FROM users WHERE id = $1", 1)
                .exec("UPDATE users SET name = $1 WHERE id = $2", "Alice Updated", 1)
                .run();

            expect(inserted).toBe(1);
            expect(users).toEqual([{ id: "1" }]);
            expect(updated).toBe(2);
        });

        it("should handle empty batch builder", async () => {
            vi.mocked(mockSession.exec)
                .mockResolvedValueOnce(0) // BEGIN
                .mockResolvedValueOnce(0); // COMMIT

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });

            const result = await ppg.batch().run();

            expect(result).toEqual([]);
            expect(mockSession.exec).toHaveBeenCalledWith("BEGIN");
            expect(mockSession.exec).toHaveBeenCalledWith("COMMIT");
        });
    });

    describe("rowToObject helper", () => {
        it("should handle multiple columns correctly", async () => {
            vi.mocked(mockClient.query).mockResolvedValue({
                columns: [
                    { name: "id", oid: 23 },
                    { name: "name", oid: 25 },
                    { name: "age", oid: 23 },
                ],
                rows: toCollectableIterator(
                    (async function* () {
                        yield { values: ["1", "Alice", "30"] };
                    })(),
                ),
            });

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });
            const rows = await ppg.query<{ id: string; name: string; age: string }>("SELECT id, name, age FROM users").collect();

            expect(rows).toEqual([{ id: "1", name: "Alice", age: "30" }]);
        });

        it("should handle null values in columns", async () => {
            vi.mocked(mockClient.query).mockResolvedValue({
                columns: [
                    { name: "id", oid: 23 },
                    { name: "nullable", oid: 25 },
                ],
                rows: toCollectableIterator(
                    (async function* () {
                        yield { values: ["1", null] };
                    })(),
                ),
            });

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });
            const rows = await ppg.query<{ id: string; nullable: string | null }>("SELECT id, nullable FROM test").collect();

            expect(rows).toEqual([{ id: "1", nullable: null }]);
        });

        it("should handle empty result set", async () => {
            vi.mocked(mockClient.query).mockResolvedValue({
                columns: [{ name: "id", oid: 23 }],
                rows: toCollectableIterator(
                    (async function* () {
                        // empty
                    })(),
                ),
            });

            const ppg = prismaPostgres({ connectionString: "postgres://user:pass@localhost:5432/mydb" });
            const rows = await ppg.query<{ id: string }>("SELECT id FROM users WHERE id = $1", 999).collect();

            expect(rows).toEqual([]);
        });
    });
});
