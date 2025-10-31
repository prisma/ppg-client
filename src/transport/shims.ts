
const hasBufferByteLength = typeof Buffer !== "undefined" && typeof Buffer.byteLength === "function";

export function utf8ByteLength(str: string): number {
    if (hasBufferByteLength) {
        return Buffer.byteLength(str, "utf8");
    }

    // the following should be more memory efficient than using TextEncoder, then throwing the result away 😅
    let bytes = 0;
    for (let i = 0; i < str.length; i++) {
        let codePoint = str.charCodeAt(i);

        // Handle surrogate pairs (UTF-16)
        if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
            const next = str.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                // Combine surrogate pair into full code point
                codePoint = ((codePoint - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
                i++; // Skip the next surrogate
            }
        }

        if (codePoint <= 0x7f) {
            bytes += 1;
        } else if (codePoint <= 0x7ff) {
            bytes += 2;
        } else if (codePoint <= 0xffff) {
            bytes += 3;
        } else {
            bytes += 4;
        }
    }
    return bytes;

}