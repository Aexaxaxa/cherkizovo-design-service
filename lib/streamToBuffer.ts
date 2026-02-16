export async function streamToBuffer(stream: unknown): Promise<Buffer> {
  if (!stream) {
    throw new Error("Empty stream");
  }

  if (stream instanceof ReadableStream) {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  }

  if (typeof (stream as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  if (stream instanceof Uint8Array) {
    return Buffer.from(stream);
  }

  throw new Error("Unsupported stream type");
}
