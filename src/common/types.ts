export interface BoundedByteStream extends ReadableStream<Uint8Array> {
    readonly byteLength: number;
}

export function boundedByteStream(readableStream: ReadableStream<Uint8Array>, byteLength: number) {
    return Object.assign(readableStream, { byteLength });
}

export function isBoundedByteStream(x: unknown): x is BoundedByteStream {
    return x instanceof ReadableStream && "byteLength" in x && typeof x.byteLength === "number";
}

export type RawParameter = string | null | Uint8Array | BoundedByteStream;
