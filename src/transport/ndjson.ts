import { DatabaseError, toCollectableIterator } from "../common/types.ts";
import { isCommandComplete, isDataRow, isDataRowDescription, isErrorFrame } from "./frames.ts";
import type { Column, StatementResponse } from "./shared.ts";

/**
 * Parses NDJSON response and creates a StatementResponse with collectable iterator for rows.
 */
export async function parseNDJSONResponse(response: Response): Promise<StatementResponse> {
    if (!response.body) {
        throw new Error("Response body is null");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Store column metadata from DataRowDescription frame
    let columns: Column[] = [];

    // Create async generator for rows
    async function* rowGenerator(): AsyncIterableIterator<(string | null)[]> {
        try {
            while (true) {
                const { done, value } = await reader.read();

                if (value) {
                    buffer += decoder.decode(value, { stream: !done });
                }

                // Process complete lines
                const lines = buffer.split("\n");

                // Keep the last incomplete line in the buffer
                if (!done) {
                    buffer = lines.pop() || "";
                } else {
                    buffer = "";
                }

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;

                    const frame = JSON.parse(trimmed);

                    if (isDataRowDescription(frame)) {
                        // DataRowDescription - save columns for later
                        columns = frame.columns.map((col) => ({ name: col.name, oid: col.oid }));
                    } else if (isDataRow(frame)) {
                        // DataRow
                        yield frame.values;
                    } else if (isCommandComplete(frame)) {
                        // CommandComplete - end of results
                        return;
                    } else if (isErrorFrame(frame)) {
                        throw new DatabaseError(frame.error);
                    }
                }

                if (done) {
                    break;
                }
            }
        } finally {
            reader.releaseLock();
        }
    }

    // Start the generator and read until we get the column metadata
    const generator = rowGenerator();

    // Kickstart the generator to populate columns by awaiting the first iteration
    // This will read frames until the first DataRow is encountered
    // The columns will be populated as a side effect
    const firstResult = await generator.next();

    // Create a wrapper generator that yields the first row (if any) and then continues with the rest
    async function* rowsWithFirst(): AsyncIterableIterator<(string | null)[]> {
        if (!firstResult.done && firstResult.value !== undefined) {
            yield firstResult.value;
        }
        yield* generator;
    }

    // Create the collectable iterator from the wrapper generator
    const rows = toCollectableIterator(rowsWithFirst());

    return {
        columns,
        rows,
    };
}
