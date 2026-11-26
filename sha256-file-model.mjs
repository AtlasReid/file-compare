import { traceSHA256, traceCompressionBlock } from './sha256-trace.mjs';

function checkAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason !== undefined ? signal.reason : new DOMException('Inspection cancelled.', 'AbortError');
}

function validateFile(file) {
  if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.slice !== 'function') {
    throw new TypeError('Choose a readable file.');
  }
}

async function readBytes(file, start, length, signal) {
  checkAborted(signal);
  if (!length) return new Uint8Array(0);
  const part = file.slice(start, start + length);
  if (!part || typeof part.arrayBuffer !== 'function') throw new TypeError('The file cannot be read.');
  const buffer = await part.arrayBuffer();
  checkAborted(signal);
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== length) {
    throw new Error('The file could not be read completely. Choose it again.');
  }
  return new Uint8Array(buffer);
}

/**
 * Inspect actual local-file bytes for the SHA-256 visualization. A short file
 * receives a complete trace. A larger file exposes only its first compression
 * block plus real final padding blocks; its full digest is computed separately
 * by the streaming comparison worker. Nothing here claims a prefix is a hash.
 */
export async function inspectFile(file, { signal } = {}) {
  validateFile(file);
  checkAborted(signal);
  const size = file.size;
  const remainder = size % 64;
  const tailStart = size - remainder;
  const paddingBlockCount = remainder < 56 ? 1 : 2;
  const blockCount = Math.floor(size / 64) + paddingBlockCount;
  const paddedLength = blockCount * 64;
  if (!Number.isSafeInteger(paddedLength)) throw new RangeError('The padded file is too large to count bytes exactly.');
  const bitCount = BigInt(size) * 8n;
  let bytes;
  let tail;
  let blocks;
  const completeTrace = size <= 512;

  if (completeTrace) {
    bytes = await readBytes(file, 0, size, signal);
    tail = bytes.subarray(tailStart);
    blocks = traceSHA256(bytes).blocks;
  } else {
    [bytes, tail] = await Promise.all([
      readBytes(file, 0, 64, signal),
      readBytes(file, tailStart, remainder, signal),
    ]);
    checkAborted(signal);
    blocks = [traceCompressionBlock(bytes)];
  }
  checkAborted(signal);

  const padding = new Uint8Array(paddingBlockCount * 64);
  padding.set(tail);
  padding[remainder] = 0x80;
  for (let i = 0; i < 8; i++) {
    padding[padding.length - 1 - i] = Number((bitCount >> BigInt(i * 8)) & 0xffn);
  }
  const paddingBlocks = [];
  for (let i = 0; i < paddingBlockCount; i++) {
    const start = i * 64;
    const kinds = Array.from({ length: 64 }, (_, j) => {
      const offset = start + j;
      return offset < remainder ? 'message' : offset === remainder ? 'marker'
        : offset >= padding.length - 8 ? 'length' : 'zero';
    });
    paddingBlocks.push({
      index: Math.floor(size / 64) + i,
      bytes: Array.from(padding.subarray(start, start + 64)),
      kinds,
    });
  }
  checkAborted(signal);
  return {
    name: typeof file.name === 'string' ? file.name : 'Untitled file',
    size,
    bitLength: bitCount.toString(),
    paddedLength,
    blockCount,
    firstBytes: Array.from(bytes.subarray(0, 64)),
    paddingBlocks,
    blocks,
    completeTrace,
  };
}
