/**
 * Prisma Postgres Serverless API Wire Protocol API module.
 */

import { type RawParameter, isBoundedByteStream } from "../common/types.ts";

/**
 *
 */
export const BINARY = "binary",
    TEXT = "text";

export type ParameterFormat = typeof BINARY | typeof TEXT;

export type InlineQueryParameter = {
    type: ParameterFormat;
    value: string | null;
};

export type ExtendedQueryParameter = {
    type: ParameterFormat;
    byteSize: number;
};

export type QueryParameter = InlineQueryParameter | ExtendedQueryParameter;

export type StatementKind = "query" | "exec";
export type QueryDescriptorFrame =
    | {
          query: string;
          parameters?: QueryParameter[];
      }
    | {
          exec: string;
          parameters?: QueryParameter[];
      };

export type ExtendedParamFrame = {
    type: ParameterFormat;
    data: string | null | Uint8Array | ReadableStream<Uint8Array>;
};

export type RequestFrame = QueryDescriptorFrame | ExtendedParamFrame;

export type WebSocketAuthFrame = {
    username: string;
    password: string;
};

export type ColumnMetadata = {
    name: string;
    typeOid: number;
};

export type DataRowDescription = {
    columns: ColumnMetadata[];
};

export type DataRow = {
    values: (string | null)[];
};

export type CommandComplete = {
    complete: true;
};

export type ErrorFrame = {
    error: {
        message: string;
        code: string;
        [key: string]: string;
    };
};

export type ResponseFrame = DataRowDescription | DataRow | CommandComplete | ErrorFrame;

const EXENDED_PARAM_SIZE_THRESHOLD = 1 << 10; // 1kb

async function streamToBase64(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let totalLength = 0;

    // Read all chunks
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalLength += value.length;
    }

    // Concatenate chunks into single Uint8Array
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
    }

    // Encode as base64
    const binaryString = Array.from(combined, (byte) => String.fromCharCode(byte)).join("");
    return btoa(binaryString);
}

export async function requestFrames(
    kind: StatementKind,
    sql: string,
    rawParams: RawParameter[],
): Promise<RequestFrame[]> {
    const queryParams: QueryParameter[] = [];
    const extendedFrames: ExtendedParamFrame[] = [];

    // Process each parameter
    for (const param of rawParams) {
        if (typeof param === "string") {
            // Handle string parameters
            const data = new TextEncoder().encode(param);
            if (data.byteLength <= EXENDED_PARAM_SIZE_THRESHOLD) {
                // Inline string parameter
                queryParams.push({
                    type: TEXT,
                    value: param,
                });
            } else {
                // Extended string parameter
                queryParams.push({
                    type: TEXT,
                    byteSize: data.byteLength,
                });
                extendedFrames.push({
                    type: TEXT,
                    data: new TextEncoder().encode(param),
                });
            }
        } else if (param instanceof Uint8Array) {
            // Handle binary Uint8Array parameters
            const byteLength = param.byteLength;

            if (byteLength <= EXENDED_PARAM_SIZE_THRESHOLD) {
                // Inline binary parameter (encode as base64)
                // Use Array.from to avoid issues with spread operator on large arrays
                const binaryString = Array.from(param, (byte) => String.fromCharCode(byte)).join("");
                const base64 = btoa(binaryString);
                queryParams.push({
                    type: BINARY,
                    value: base64,
                });
            } else {
                // Extended binary parameter
                queryParams.push({
                    type: BINARY,
                    byteSize: byteLength,
                });
                extendedFrames.push({
                    type: BINARY,
                    data: param,
                });
            }
        } else if (isBoundedByteStream(param)) {
            if (param.byteLength <= EXENDED_PARAM_SIZE_THRESHOLD) {
                // For small bounded streams, read and encode as base64
                const base64 = await streamToBase64(param);
                queryParams.push({
                    type: BINARY,
                    value: base64,
                });
            } else {
                queryParams.push({
                    type: BINARY,
                    byteSize: param.byteLength,
                });
                extendedFrames.push({
                    type: BINARY,
                    data: param,
                });
            }
        } else if (param === null) {
            queryParams.push({
                type: TEXT,
                value: null,
            });
        } else {
            throw new Error(`unsupported raw parameter type: ${param}`);
        }
    }

    const parameters = queryParams.length > 0 ? queryParams : undefined;

    const queryDescriptor: QueryDescriptorFrame =
        kind === "query" ? { query: sql, parameters } : { exec: sql, parameters };

    return [queryDescriptor, ...extendedFrames];
}
