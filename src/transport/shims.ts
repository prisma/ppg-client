
const hasBufferByteLength = typeof Buffer !== "undefined" && typeof Buffer.byteLength === "function";

export function utf8ByteLength(str: string): number {
    if (hasBufferByteLength) {
        return Buffer.byteLength(str, "utf8");
    }
    return new TextEncoder().encode(str).length;
}