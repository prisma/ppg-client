

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

export interface HttpTransportConfig {
    endpoint: string;
    username: string;
    password: string;
    database?: string;
}
