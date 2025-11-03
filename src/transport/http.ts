import { HttpResponseError, type RawParameter } from "../common/types.ts";
import { type RequestFrame, type StatementKind, requestFrames } from "./frames.ts";
import { createMultipartStream } from "./multipart.ts";
import { parseNDJSONResponse } from "./ndjson.ts";
import { type BaseTransport, FRAME_URNS, MIME_TYPES, type StatementResponse, type TransportConfig } from "./shared.ts";

const HTTP_REQUEST_PATH = "/db/query_v2"; // TODO: change this

export interface HttpTransport extends BaseTransport {}

export function httpTransport(config: TransportConfig): HttpTransport {
    async function statement(kind: StatementKind, sql: string, parameters: RawParameter[]): Promise<StatementResponse> {
        // Build request frames using the requestFrames factory function
        const frames = await requestFrames(kind, sql, parameters);

        // Construct the full URL
        const url = new URL(HTTP_REQUEST_PATH, config.endpoint);
        if (config.database) {
            url.searchParams.set("db", config.database);
        }

        // Prepare authentication headers
        const authHeader = `Basic ${btoa(`${config.username}:${config.password}`)}`;
        const headers = {
            Authorization: authHeader,
        };

        // Delegate to request() for multipart encoding and response parsing
        return request({ url: url.toString(), headers, frames, keepalive: config.keepalive ?? false });
    }

    return { statement };
}

interface QueryHttpRequest {
    url: string;
    headers: Record<string, string>;
    frames: RequestFrame[];
    keepalive: boolean;
}

async function request({ headers, keepalive, frames, url }: QueryHttpRequest): Promise<StatementResponse> {
    // Generate a unique boundary for multipart/form-data
    const boundary = `----PPGBoundary${Date.now()}${Math.random().toString(36).substring(2)}`;

    // Create a ReadableStream from the multipart generator
    const bodyStream = createMultipartStream(frames, boundary);

    const requestInit = {
        method: "POST",
        headers: {
            ...headers,
            "Content-Type": `${MIME_TYPES.multipartFormData}; profile="${FRAME_URNS.queryUrn}"; boundary=${boundary}`,
        },
        body: bodyStream,
        duplex: "half",
        keepalive, // node doesn't seem to support it, throws a TypeError when this is true
    };

    // Make the HTTP request
    const response = await fetch(url, requestInit);

    if (!response.ok) {
        const responseText = await response.text();
        const message = responseText || `HTTP error ${response.status}: ${response.statusText}`;
        throw new HttpResponseError({ message, statusCode: response.status });
    }

    // Parse NDJSON response and create StatementResponse
    return parseNDJSONResponse(response);
}
