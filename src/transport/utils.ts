export function utf8ByteLength(str: string): number {
    if (typeof Buffer !== "undefined" && typeof Buffer.byteLength === "function") {
        return Buffer.byteLength(str, "utf8");
    }
    return new TextEncoder().encode(str).length;
}
