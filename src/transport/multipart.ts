import { isByteArrayParameter, isBoundedByteStream } from "../common/types";
import { RequestFrame, isQueryDescriptorFrame, isExtendedParamFrame } from "./frames";
import { FRAME_URNS, MIME_TYPES } from "./shared";

/**
 * Creates a ReadableStream that generates multipart/form-data body from request frames.
 * This allows streaming large parameters without buffering everything in memory.
 */
export function createMultipartStream(frames: RequestFrame[], boundary: string): ReadableStream<Uint8Array> {
    const textEncoder = new TextEncoder();

    async function* multipartGenerator(): AsyncGenerator<Uint8Array> {
        for (const frame of frames) {
            // Yield boundary
            yield textEncoder.encode(`--${boundary}\r\n`);

            if (isQueryDescriptorFrame(frame)) {
                // QueryDescriptorFrame
                const descriptor = frame;
                yield textEncoder.encode(`Content-Disposition: form-data; name="${FRAME_URNS.queryDescriptorUrn}"\r\n`);
                yield textEncoder.encode(
                    `Content-Type: ${MIME_TYPES.applicationJson}; profile="${FRAME_URNS.queryDescriptorUrn}"\r\n\r\n`,
                );
                yield textEncoder.encode(`${JSON.stringify(descriptor)}\r\n`);
            } else if (isExtendedParamFrame(frame)) {
                // ExtendedParamFrame
                const extendedParam = frame;

                if (extendedParam.type === "text") {
                    // Text parameter
                    yield textEncoder.encode(`Content-Disposition: form-data; name="${FRAME_URNS.textParamUrn}"\r\n`);
                    yield textEncoder.encode(
                        `Content-Type: ${MIME_TYPES.textPlain}; charset=utf-8; profile="${FRAME_URNS.textParamUrn}"\r\n\r\n`,
                    );

                    const param = extendedParam.data

                    if (typeof param === 'string') {
                        // Plain string - encode and send
                        yield textEncoder.encode(param);
                        yield textEncoder.encode("\r\n");
                    } else if (isByteArrayParameter(param)) {
                        // Text encoded as Uint8Array (from ByteArrayParameter with TEXT format)
                        yield param;
                        yield textEncoder.encode("\r\n");
                    } else if (isBoundedByteStream(param)) {
                        // Stream the data (from BoundedByteStream with TEXT format or string via TextEncoderStream)
                        const reader = param.getReader();
                        try {
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) break;
                                yield value;
                            }
                        } finally {
                            reader.releaseLock();
                        }
                        yield textEncoder.encode("\r\n");
                    } else {
                        throw new Error(
                            `Unsupported text extended parameter data type. Expected string, ByteArrayParameter, or BoundedByteStream, got: ${typeof param}`
                        );
                    }
                } else {
                    // Binary parameter
                    yield textEncoder.encode(`Content-Disposition: form-data; name="${FRAME_URNS.binaryParamUrn}"\r\n`);
                    yield textEncoder.encode(
                        `Content-Type: ${MIME_TYPES.applicationOctetStream}; profile="${FRAME_URNS.binaryParamUrn}"\r\n\r\n`,
                    );

                    if (typeof extendedParam.data === 'string') {
                        // Plain string for binary - encode as UTF-8 bytes
                        yield textEncoder.encode(extendedParam.data);
                        yield textEncoder.encode("\r\n");
                    } else if (isByteArrayParameter(extendedParam.data)) {
                        yield extendedParam.data;
                        yield textEncoder.encode("\r\n");
                    } else if (isBoundedByteStream(extendedParam.data)) {
                        // Stream the data
                        const reader = extendedParam.data.getReader();
                        try {
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) break;
                                yield value;
                            }
                        } finally {
                            reader.releaseLock();
                        }
                        yield textEncoder.encode("\r\n");
                    } else {
                        throw new Error(
                            `Unsupported binary extended parameter data type. Expected string, ByteArrayParameter, or BoundedByteStream, got: ${typeof extendedParam.data}`
                        );
                    }
                }
            } else {
                throw new Error(
                    `Unsupported frame type. Expected QueryDescriptorFrame or ExtendedParamFrame, got: ${JSON.stringify(frame)}`
                );
            }
        }

        // Yield closing boundary
        yield textEncoder.encode(`--${boundary}--\r\n`);
    }

    // Convert async generator to ReadableStream with proper backpressure
    const iterator = multipartGenerator();

    return new ReadableStream({
        async pull(controller) {
            try {
                const { done, value } = await iterator.next();

                if (done) {
                    controller.close();
                } else {
                    controller.enqueue(value);
                }
            } catch (error) {
                controller.error(error);
            }
        },

        async cancel(reason) {
            // Clean up the generator if the stream is cancelled
            await iterator.return?.(reason);
        },
    });
}