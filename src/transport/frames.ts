/**
 * Prisma Postgres Serverless API Wire Protocol API module.
 */

import {
    BINARY,
    type ParameterFormat,
    type RawParameter,
    TEXT,
    boundedByteStreamParameter,
    isBoundedByteStreamParameter,
    isByteArrayParameter,
} from "../common/types.ts";
import { utf8ByteLength } from "./shims.ts";

export type InlineQueryParameter = {
    type: ParameterFormat;
    value: string | null;
};

export type ExtendedQueryParameter = {
    type: ParameterFormat;
    byteSize: number;
};

type Parameter = InlineQueryParameter | ExtendedQueryParameter;

export type StatementKind = "query" | "exec";
export type QueryDescriptorFrame =
    | {
          query: string;
          parameters?: Parameter[];
      }
    | {
          exec: string;
          parameters?: Parameter[];
      };

export type ExtendedParamFrame = {
    type: ParameterFormat;
    data: NonNullable<RawParameter>;
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

function isNonNull(x: unknown): x is object {
    return !!x && typeof x === "object";
}

// Type guards for RequestFrame types
export function isQueryDescriptorFrame(frame: unknown): frame is QueryDescriptorFrame {
    return (
        isNonNull(frame) &&
        (("query" in frame && typeof frame.query === "string") || ("exec" in frame && typeof frame.exec === "string"))
    );
}

export function isExtendedParamFrame(frame: unknown): frame is ExtendedParamFrame {
    return isNonNull(frame) && "type" in frame && "data" in frame && (frame.type === "text" || frame.type === "binary");
}

// Type guards for ResponseFrame types
export function isDataRowDescription(frame: unknown): frame is DataRowDescription {
    return isNonNull(frame) && "columns" in frame && Array.isArray(frame.columns);
}

export function isDataRow(frame: unknown): frame is DataRow {
    return isNonNull(frame) && "values" in frame && Array.isArray(frame.values);
}

export function isCommandComplete(frame: unknown): frame is CommandComplete {
    return isNonNull(frame) && "complete" in frame && frame.complete === true;
}

export function isErrorFrame(frame: unknown): frame is ErrorFrame {
    return (
        isNonNull(frame) &&
        "error" in frame &&
        typeof frame.error === "object" &&
        frame.error !== null &&
        "message" in frame.error &&
        typeof frame.error.message === "string"
    );
}

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
    const queryParams: Parameter[] = [];
    const extendedFrames: ExtendedParamFrame[] = [];

    // Process each parameter
    for (const param of rawParams) {
        if (typeof param === "string") {
            // Handle string parameters - assume TEXT format
            const byteLength = utf8ByteLength(param);
            if (byteLength <= EXENDED_PARAM_SIZE_THRESHOLD) {
                // Inline string parameter
                queryParams.push({
                    type: TEXT,
                    value: param,
                });
            } else {
                // Extended string parameter - use TextEncoderStream for memory efficiency
                queryParams.push({
                    type: TEXT,
                    byteSize: byteLength,
                });
                // Create a stream from the string using TextEncoderStream
                const stringStream = new ReadableStream({
                    start(controller) {
                        controller.enqueue(param);
                        controller.close();
                    },
                });
                const encoderStream = new TextEncoderStream();
                const encodedStream = stringStream.pipeThrough(encoderStream);
                // Wrap as BoundedByteStream to include format and byteLength metadata
                const boundedStream = boundedByteStreamParameter(encodedStream, TEXT, byteLength);

                extendedFrames.push({
                    type: TEXT,
                    data: boundedStream,
                });
            }
        } else if (isByteArrayParameter(param)) {
            // Handle ByteArrayParameter with explicit format
            const byteLength = param.byteLength;
            const format = param.format;

            if (byteLength <= EXENDED_PARAM_SIZE_THRESHOLD) {
                if (format === TEXT) {
                    // Inline text parameter from byte array
                    const textValue = new TextDecoder().decode(param);
                    queryParams.push({
                        type: TEXT,
                        value: textValue,
                    });
                } else {
                    // Inline binary parameter (encode as base64)
                    const binaryString = Array.from(param, (byte) => String.fromCharCode(byte)).join("");
                    const base64 = btoa(binaryString);
                    queryParams.push({
                        type: BINARY,
                        value: base64,
                    });
                }
            } else {
                // Extended parameter
                queryParams.push({
                    type: format,
                    byteSize: byteLength,
                });
                extendedFrames.push({
                    type: format,
                    data: param,
                });
            }
        } else if (isBoundedByteStreamParameter(param)) {
            // Handle BoundedByteStream with explicit format
            const format = param.format;
            if (param.byteLength <= EXENDED_PARAM_SIZE_THRESHOLD) {
                // For small bounded streams, read and process based on format
                if (format === TEXT) {
                    // Decode as text
                    const chunks: Uint8Array[] = [];
                    const reader = param.getReader();
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        chunks.push(value);
                    }
                    const combined = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
                    let offset = 0;
                    for (const chunk of chunks) {
                        combined.set(chunk, offset);
                        offset += chunk.length;
                    }
                    const textValue = new TextDecoder().decode(combined);
                    queryParams.push({
                        type: TEXT,
                        value: textValue,
                    });
                } else {
                    // Encode as base64 for binary
                    const base64 = await streamToBase64(param);
                    queryParams.push({
                        type: BINARY,
                        value: base64,
                    });
                }
            } else {
                queryParams.push({
                    type: format,
                    byteSize: param.byteLength,
                });
                extendedFrames.push({
                    type: format,
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
