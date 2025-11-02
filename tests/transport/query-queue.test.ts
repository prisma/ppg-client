import { describe, expect, it } from "vitest";
import type { CommandComplete, DataRow, DataRowDescription, ErrorFrame } from "../../src/transport/frames.ts";
import { newQueryQueue } from "../../src/transport/query-queue.ts";
import { FRAME_URNS } from "../../src/transport/shared.ts";
import { runEventLoop } from "./websocket-test-utils.ts";

describe("QueryQueue", () => {
    describe("isEmpty()", () => {
        it("should return true when queue is empty", () => {
            const queue = newQueryQueue();
            expect(queue.isEmpty()).toBe(true);
        });

        it("should return false when queue has queries", () => {
            const queue = newQueryQueue();
            queue.enqueueNew();
            expect(queue.isEmpty()).toBe(false);
        });

        it("should return true after all queries are processed", async () => {
            const queue = newQueryQueue();
            queue.enqueueNew();

            const commandComplete: CommandComplete = { complete: true };
            queue.processFrame(FRAME_URNS.commandCompleteUrn, commandComplete);

            expect(queue.isEmpty()).toBe(true);
        });
    });

    describe("enqueueNew()", () => {
        it("should return an EnqueuedQuery with promise and abort", () => {
            const queue = newQueryQueue();
            const enqueued = queue.enqueueNew();

            expect(enqueued).toHaveProperty("promise");
            expect(enqueued).toHaveProperty("abort");
            expect(enqueued.promise).toBeInstanceOf(Promise);
            expect(typeof enqueued.abort).toBe("function");
        });

        it("should allow multiple queries to be enqueued", () => {
            const queue = newQueryQueue();
            queue.enqueueNew();
            queue.enqueueNew();
            queue.enqueueNew();

            expect(queue.isEmpty()).toBe(false);
        });
    });

    describe("processFrame() - single query flow", () => {
        it("should process a complete query with columns only", async () => {
            const queue = newQueryQueue();
            const enqueued = queue.enqueueNew();

            // Send DataRowDescription
            const rowDesc: DataRowDescription = {
                columns: [
                    { name: "id", oid: 23 },
                    { name: "name", oid: 25 },
                ],
            };
            queue.processFrame(FRAME_URNS.dataRowDescriptionUrn, rowDesc);

            // Complete immediately without rows
            queue.processFrame(FRAME_URNS.commandCompleteUrn, { complete: true } as CommandComplete);

            const response = await enqueued.promise;

            expect(response.columns).toEqual([
                { name: "id", oid: 23 },
                { name: "name", oid: 25 },
            ]);
            expect(queue.isEmpty()).toBe(true);
        });

        it("should handle query with no rows", async () => {
            const queue = newQueryQueue();
            const enqueued = queue.enqueueNew();

            const rowDesc: DataRowDescription = {
                columns: [{ name: "id", oid: 23 }],
            };
            queue.processFrame(FRAME_URNS.dataRowDescriptionUrn, rowDesc);

            // Immediately complete without sending any rows
            const complete: CommandComplete = { complete: true };
            queue.processFrame(FRAME_URNS.commandCompleteUrn, complete);

            const response = await enqueued.promise;

            expect(response.columns).toEqual([{ name: "id", oid: 23 }]);
            // rows iterator exists but will immediately end
            const firstRow = await response.rows.next();
            expect(firstRow.done).toBe(true);
            expect(queue.isEmpty()).toBe(true);
        });

        it("should handle error frame", async () => {
            const queue = newQueryQueue();
            const enqueued = queue.enqueueNew();

            const errorFrame: ErrorFrame = {
                error: {
                    message: "syntax error at position 10",
                    code: "42601",
                },
            };

            queue.processFrame(FRAME_URNS.errorUrn, errorFrame);

            await expect(enqueued.promise).rejects.toThrow("syntax error at position 10");
            expect(queue.isEmpty()).toBe(true);
        });

        it("should reject row iterator when error occurs mid-query", async () => {
            const queue = newQueryQueue();
            const enqueued = queue.enqueueNew();

            const rowDesc: DataRowDescription = {
                columns: [{ name: "id", oid: 23 }],
            };
            queue.processFrame(FRAME_URNS.dataRowDescriptionUrn, rowDesc);

            // Start consuming rows
            const iterationPromise = (async () => {
                const response = await enqueued.promise;
                const rows: (string | null)[][] = [];
                for await (const row of response.rows) {
                    rows.push(row);
                }
                return rows;
            })();

            await runEventLoop();

            // Send one row successfully
            const row1: DataRow = { values: ["1"] };
            queue.processFrame(FRAME_URNS.dataRowUrn, row1);

            await runEventLoop();

            // Then error occurs
            const errorFrame: ErrorFrame = {
                error: { message: "connection lost", code: "08006" },
            };
            queue.processFrame(FRAME_URNS.errorUrn, errorFrame);

            await expect(iterationPromise).rejects.toThrow("connection lost");
        });
    });

    describe("processFrame() - multiple queries (sequential)", () => {
        it("should process queries in FIFO order", async () => {
            const queue = newQueryQueue();
            const query1 = queue.enqueueNew();
            const query2 = queue.enqueueNew();

            // Process first query
            const rowDesc1: DataRowDescription = { columns: [{ name: "a", oid: 23 }] };
            queue.processFrame(FRAME_URNS.dataRowDescriptionUrn, rowDesc1);

            const row1: DataRow = { values: ["1"] };
            queue.processFrame(FRAME_URNS.dataRowUrn, row1);

            const complete1: CommandComplete = { complete: true };
            queue.processFrame(FRAME_URNS.commandCompleteUrn, complete1);

            // First query should complete
            const response1 = await query1.promise;
            expect(response1.columns).toEqual([{ name: "a", oid: 23 }]);

            // Process second query
            const rowDesc2: DataRowDescription = { columns: [{ name: "b", oid: 25 }] };
            queue.processFrame(FRAME_URNS.dataRowDescriptionUrn, rowDesc2);

            const row2: DataRow = { values: ["hello"] };
            queue.processFrame(FRAME_URNS.dataRowUrn, row2);

            const complete2: CommandComplete = { complete: true };
            queue.processFrame(FRAME_URNS.commandCompleteUrn, complete2);

            const response2 = await query2.promise;
            expect(response2.columns).toEqual([{ name: "b", oid: 25 }]);

            expect(queue.isEmpty()).toBe(true);
        });

        it("should not process frames when queue is empty", () => {
            const queue = newQueryQueue();

            // Process frame without any enqueued queries - should not throw
            const row: DataRow = { values: ["1"] };
            expect(() => queue.processFrame(FRAME_URNS.dataRowUrn, row)).not.toThrow();
        });
    });

    describe("abortAll()", () => {
        it("should reject all pending queries", async () => {
            const queue = newQueryQueue();
            const query1 = queue.enqueueNew();
            const query2 = queue.enqueueNew();
            const query3 = queue.enqueueNew();

            const abortError = new Error("Connection closed");
            queue.abortAll(abortError);

            await expect(query1.promise).rejects.toThrow("Connection closed");
            await expect(query2.promise).rejects.toThrow("Connection closed");
            await expect(query3.promise).rejects.toThrow("Connection closed");

            expect(queue.isEmpty()).toBe(true);
        });

        it("should clear the queue", async () => {
            const queue = newQueryQueue();
            const q1 = queue.enqueueNew();
            const q2 = queue.enqueueNew();

            expect(queue.isEmpty()).toBe(false);

            queue.abortAll(new Error("test"));

            // Catch the rejections to avoid unhandled promise rejections
            await expect(q1.promise).rejects.toThrow("test");
            await expect(q2.promise).rejects.toThrow("test");

            expect(queue.isEmpty()).toBe(true);
        });
    });

    describe("reject() method", () => {
        it("should allow manual rejection of a query", async () => {
            const queue = newQueryQueue();
            const enqueued = queue.enqueueNew();

            enqueued.abort(new Error("Manual rejection"));

            await expect(enqueued.promise).rejects.toThrow("Manual rejection");
        });

        it("should not affect other queries in the queue", async () => {
            const queue = newQueryQueue();
            const query1 = queue.enqueueNew();
            const query2 = queue.enqueueNew();

            // Complete first query normally
            queue.processFrame(FRAME_URNS.dataRowDescriptionUrn, { columns: [{ name: "a", oid: 23 }] });
            queue.processFrame(FRAME_URNS.commandCompleteUrn, { complete: true });

            const response1 = await query1.promise;
            expect(response1.columns).toEqual([{ name: "a", oid: 23 }]);

            // Second query should still work after first completes
            const rowDesc: DataRowDescription = { columns: [{ name: "id", oid: 25 }] };
            queue.processFrame(FRAME_URNS.dataRowDescriptionUrn, rowDesc);

            const complete: CommandComplete = { complete: true };
            queue.processFrame(FRAME_URNS.commandCompleteUrn, complete);

            const response2 = await query2.promise;
            expect(response2.columns).toEqual([{ name: "id", oid: 25 }]);
        });
    });

    describe("row iteration with collect()", () => {
        it("should allow collecting remaining rows", async () => {
            const queue = newQueryQueue();
            const enqueued = queue.enqueueNew();

            const rowDesc: DataRowDescription = {
                columns: [{ name: "id", oid: 23 }],
            };
            queue.processFrame(FRAME_URNS.dataRowDescriptionUrn, rowDesc);

            const consumePromise = (async () => {
                const response = await enqueued.promise;
                // Get first row manually
                await runEventLoop();
                const first = await response.rows.next();

                await runEventLoop();
                // Collect the rest
                const rest = await response.rows.collect();

                return { first: first.value, rest };
            })();

            await runEventLoop();

            queue.processFrame(FRAME_URNS.dataRowUrn, { values: ["1"] });
            await runEventLoop();

            queue.processFrame(FRAME_URNS.dataRowUrn, { values: ["2"] });
            await runEventLoop();

            queue.processFrame(FRAME_URNS.dataRowUrn, { values: ["3"] });
            await runEventLoop();

            queue.processFrame(FRAME_URNS.commandCompleteUrn, { complete: true });

            const result = await consumePromise;
            expect(result.first).toEqual(["1"]);
            expect(result.rest).toEqual([["2"], ["3"]]);
        });
    });

    describe("edge cases", () => {
        it("should handle protocol violation by aborting all queries", async () => {
            const queue = newQueryQueue();
            const query1 = queue.enqueueNew();
            const query2 = queue.enqueueNew();

            // Send invalid/unexpected frame URN (protocol violation) before any valid frames
            queue.processFrame("urn:invalid:frame", { some: "data" });

            // All queries should be aborted due to protocol error
            await expect(query1.promise).rejects.toThrow(
                "Protocol error: unexpected frame URN 'urn:invalid:frame' for current query state",
            );
            await expect(query2.promise).rejects.toThrow(
                "Protocol error: unexpected frame URN 'urn:invalid:frame' for current query state",
            );

            expect(queue.isEmpty()).toBe(true);
        });

        it("should handle CommandComplete without DataRowDescription", async () => {
            const queue = newQueryQueue();
            const enqueued = queue.enqueueNew();

            const complete: CommandComplete = { complete: true };
            queue.processFrame(FRAME_URNS.commandCompleteUrn, complete);

            const response = await enqueued.promise;
            expect(response.columns).toEqual([]);
        });

        it("should handle null values in rows", async () => {
            const queue = newQueryQueue();
            const enqueued = queue.enqueueNew();

            const rowDesc: DataRowDescription = {
                columns: [{ name: "optional", oid: 25 }],
            };
            queue.processFrame(FRAME_URNS.dataRowDescriptionUrn, rowDesc);

            const rowsPromise = (async () => {
                const response = await enqueued.promise;
                return await response.rows.collect();
            })();

            await runEventLoop();

            queue.processFrame(FRAME_URNS.dataRowUrn, { values: [null] });
            await runEventLoop();

            queue.processFrame(FRAME_URNS.commandCompleteUrn, { complete: true });

            const rows = await rowsPromise;
            expect(rows).toEqual([[null]]);
        });

        it("should handle error without message", async () => {
            const queue = newQueryQueue();
            const enqueued = queue.enqueueNew();

            const errorFrame: ErrorFrame = {
                error: {
                    message: "",
                    code: "XX000",
                    detail: "unknown error",
                },
            };

            queue.processFrame(FRAME_URNS.errorUrn, errorFrame);

            await expect(enqueued.promise).rejects.toThrow("");
        });
    });
});
