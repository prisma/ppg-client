import { DatabaseError } from "../api/client.ts";
import { toCollectableIterator } from "../common/types.ts";
import {
    type DataRow,
    type DataRowDescription,
    type ErrorFrame,
    isCommandComplete,
    isDataRow,
    isDataRowDescription,
    isErrorFrame,
} from "./frames.ts";
import { FRAME_URNS, type StatementResponse } from "./shared.ts";
import { type Deferred, createDeferred, emptyIterableIterator } from "./shims.ts";

type RowIteratorResult = IteratorResult<(string | null)[]>;

export interface EnqueuedQuery {
    readonly promise: Promise<StatementResponse>;
    abort(error: Error): void;
}

export interface QueryQueue {
    isEmpty(): boolean;
    processFrame(urn: string, payload: unknown): void;
    enqueueNew(): EnqueuedQuery;
    abortAll(error: Error): void;
}

interface RunningQuery {
    rowDescription(descr: DataRowDescription): void;
    dataRow(row: DataRow): void;
    error(err: ErrorFrame): void;
    abort(err: Error): void;
    complete(): void;
    readonly statementPromise: Promise<StatementResponse>;
}

function newRunningQuery(): RunningQuery {
    const statementDeferred = createDeferred<StatementResponse>();

    const rowBuffer: (string | null)[][] = []; // Buffer for rows that arrive before iteration starts or while the consumer is busy
    let completed = false;
    let rowDeferred: Deferred<RowIteratorResult> | null;
    let columns: { name: string; oid: number }[] = [];

    function tryResolveRow(value: RowIteratorResult) {
        if (rowDeferred) {
            // Someone is waiting - resolve immediately
            rowDeferred.resolve(value);
            rowDeferred = null;
            return true;
        }
        return false;
    }

    function tryRejectRow(error: Error) {
        if (rowDeferred) {
            rowDeferred.reject(error);
            rowDeferred = null;
            return true;
        }
        return false;
    }

    // Create async iterator for rows with direct state reference
    async function* rowGenerator(): AsyncIterableIterator<(string | null)[]> {
        while (true) {
            // First, check if there are buffered rows
            if (rowBuffer.length > 0) {
                yield rowBuffer.shift()!;
                continue;
            }

            // If completed and no buffered rows, we're done
            if (completed) {
                break;
            }

            // Wait for next row
            rowDeferred = createDeferred<RowIteratorResult>();

            const result = await rowDeferred.promise;
            if (result.done) break;
            yield result.value;
        }
    }

    function rowDescription(descr: DataRowDescription) {
        // Populate columns
        columns = descr.columns.map((col) => ({
            name: col.name,
            oid: col.typeOid,
        }));
        // Resolve the promise now that we have columns
        // The rows iterator was already created and is ready to stream
        statementDeferred.resolve({
            columns,
            rows: toCollectableIterator(rowGenerator()),
        });
    }

    function dataRow(row: DataRow) {
        if (!tryResolveRow({ value: row.values, done: false })) {
            // No one waiting - buffer the row
            rowBuffer.push(row.values);
        }
    }

    function error({ error }: ErrorFrame) {
        const err = new DatabaseError(error.message, error.code, error);
        abort(err);
    }

    function complete() {
        // Mark query as completed - no more rows will arrive
        completed = true;

        // If someone is currently waiting for next row, signal completion
        tryResolveRow({ value: undefined, done: true });

        // Resolve the promise if it hasn't been resolved yet
        // (happens when there's no DataRowDescription, e.g., INSERT/UPDATE)
        statementDeferred.resolve({
            columns: columns,
            rows: toCollectableIterator(emptyIterableIterator()),
        });
    }

    function abort(err: Error) {
        if (!tryRejectRow(err)) {
            statementDeferred.reject(err);
        }
    }

    return {
        rowDescription,
        dataRow,
        error,
        complete,
        abort,
        statementPromise: statementDeferred.promise,
    };
}

export function newQueryQueue(): QueryQueue {
    // Query queue tracks response ordering
    const queryQueue: RunningQuery[] = [];

    function enqueueNew(): EnqueuedQuery {
        const query = newRunningQuery();
        queryQueue.push(query);

        return {
            promise: query.statementPromise,
            abort: query.abort,
        };
    }

    function processFrame(urn: string, payload: unknown) {
        if (queryQueue.length === 0) return;

        const currentQuery = queryQueue[0];

        if (urn === FRAME_URNS.dataRowDescriptionUrn && isDataRowDescription(payload)) {
            currentQuery.rowDescription(payload);
        } else if (urn === FRAME_URNS.dataRowUrn && isDataRow(payload)) {
            currentQuery.dataRow(payload);
        } else if (urn === FRAME_URNS.commandCompleteUrn && isCommandComplete(payload)) {
            currentQuery.complete();
            // Remove from queue - this query is done.
            // Even with pipelining, results will **always** follow the FIFO ordering.
            queryQueue.shift();
        } else if (urn === FRAME_URNS.errorUrn && isErrorFrame(payload)) {
            currentQuery.error(payload);
            queryQueue.shift();
        } else {
            // Protocol violation: received unexpected frame type
            // This is critical - abort all queries as the connection is in an invalid state
            const protocolError = new Error(`Protocol error: unexpected frame URN '${urn}' for current query state`);
            abortAll(protocolError);
        }
    }

    function abortAll(error: Error) {
        for (const q of queryQueue) {
            q.abort(error);
        }
        queryQueue.length = 0;
    }

    function isEmpty() {
        return queryQueue.length === 0;
    }

    return {
        isEmpty,
        enqueueNew,
        processFrame,
        abortAll,
    };
}
