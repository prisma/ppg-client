import { type RawParameter } from "../common/types.ts";
import {
    type RequestFrame,
    type StatementKind,
    requestFrames,
} from "./frames.ts";
import { createMultipartStream } from "./multipart.ts";
import { parseNDJSONResponse } from "./ndjson.ts";
import { FRAME_URNS, type HttpTransportConfig, MIME_TYPES, type StatementResponse } from "./shared.ts";

const HTTP_REQUEST_PATH = "/db/query_v2"; // TODO: change this

export interface HttpTransport {
    statement(kind: StatementKind, sql: string, parameters: RawParameter[]): Promise<StatementResponse>;
}

export function httpTransport(config: HttpTransportConfig): HttpTransport {
    async function statement(kind: StatementKind, sql: string, parameters: RawParameter[]): Promise<StatementResponse> {
        // Build request frames using the requestFrames factory function
        const frames = await requestFrames(kind, sql, parameters);

        // Construct the full URL
        const url = new URL(HTTP_REQUEST_PATH, config.endpoint);
        if (config.database) {
            url.searchParams.set("database", config.database);
        }

        // Prepare authentication headers
        const authHeader = `Basic ${btoa(`${config.username}:${config.password}`)}`;
        const headers = {
            Authorization: authHeader,
        };

        // Delegate to request() for multipart encoding and response parsing
        return request(url.toString(), headers, frames);
    }

    return { statement };
}

// TODO: keepalive (?)

async function request(url: string, headers: Record<string, string>, req: RequestFrame[]): Promise<StatementResponse> {
    // Generate a unique boundary for multipart/form-data
    const boundary = `----PPGBoundary${Date.now()}${Math.random().toString(36).substring(2)}`;

    // Create a ReadableStream from the multipart generator
    const bodyStream = createMultipartStream(req, boundary);

    // Make the HTTP request
    const response = await fetch(url, {
        method: "POST",
        headers: {
            ...headers,
            "Content-Type": `${MIME_TYPES.multipartFormData}; profile="${FRAME_URNS.queryUrn}"; boundary=${boundary}`,
        },
        body: bodyStream,
    });

    if (!response.ok) {
        throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
    }

    // Parse NDJSON response and create StatementResponse
    return parseNDJSONResponse(response);
}

