import type { CollectableIterator, RawParameter } from "../common/types.ts";
import type { StatementKind } from "./frames.ts";

export type FrameUrn = (typeof FRAME_URNS)[keyof typeof FRAME_URNS];
export const FRAME_URNS = {
    queryUrn: "urn:prisma:query",
    queryDescriptorUrn: "urn:prisma:query:descriptor",
    binaryParamUrn: "urn:prisma:query:param:binary",
    textParamUrn: "urn:prisma:query:param:text",
    dataRowDescriptionUrn: "urn:prisma:query:result:description",
    dataRowUrn: "urn:prisma:query:result:datarow",
    commandCompleteUrn: "urn:prisma:query:result:complete",
    errorUrn: "urn:prisma:query:result:error",
} as const;

export type MimeTypes = (typeof MIME_TYPES)[keyof typeof MIME_TYPES];
export const MIME_TYPES = {
    applicationJson: "application/json",
    applicationNdJson: "application/x-ndjson",
    applicationOctetStream: "application/octet-stream",
    multipartFormData: "multipart/form-data",
    multipartMixed: "multipart/mixed",
    textPlain: "text/plain",
} as const;

export interface TransportConfig {
    endpoint: string;
    username: string;
    password: string;
    database?: string;
    keepalive?: boolean;
}

export interface StatementResponse {
    readonly columns: Column[];
    readonly rows: CollectableIterator<(string | null)[]>;
}

export interface BaseTransport {
    statement(kind: StatementKind, sql: string, parameters: RawParameter[]): Promise<StatementResponse>;
}

/**
 * Resultset column descriptor.
 */
export interface Column {
    /**
     * Name of the column.
     */
    name: string;

    /**
     * Object identifier of the column type.
     *
     * If you need to know the column type name, you can use the `oid` to query
     * the `pg_type` catalog:
     *
     * ```ts
     * await client.run({
     *   sql: `SELECT typname FROM pg_type WHERE oid = $1`,
     *   parameters: [column.oid],
     * });
     * ```
     */
    oid: number;
}
