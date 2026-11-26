// Dependency-free, browser-local comparison. Each file is read in bounded chunks.
// `identical` comes from comparing every byte, independently of the SHA-256 hashes.

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotateRight = (value, count) => (value >>> count) | (value << (32 - count));

export class IncrementalSHA256 {
  constructor() {
    this.state = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    this.block = new Uint8Array(64);
    this.words = new Uint32Array(64);
    this.buffered = 0;
    this.byteLength = 0;
    this.result = null;
  }

  update(input) {
    if (this.result !== null) throw new Error('This SHA-256 digest is already finished.');
    const bytes = input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : null;
    if (!bytes) throw new TypeError('SHA-256 input must be an ArrayBuffer or a typed array.');
    if (!Number.isSafeInteger(this.byteLength + bytes.byteLength)) {
      throw new RangeError('The file is too large to count bytes exactly.');
    }
    this.byteLength += bytes.byteLength;
    let offset = 0;
    if (this.buffered) {
      const count = Math.min(64 - this.buffered, bytes.byteLength);
      this.block.set(bytes.subarray(0, count), this.buffered);
      this.buffered += count;
      offset = count;
      if (this.buffered === 64) {
        this._compress(this.block, 0);
        this.buffered = 0;
      }
    }
    while (offset + 64 <= bytes.byteLength) {
      this._compress(bytes, offset);
      offset += 64;
    }
    if (offset < bytes.byteLength) {
      this.block.set(bytes.subarray(offset), 0);
      this.buffered = bytes.byteLength - offset;
    }
    return this;
  }

  _compress(bytes, offset) {
    const w = this.words;
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.state;
    for (let i = 0; i < 64; i++) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choice + ROUND_CONSTANTS[i] + w[i]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    const work = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) this.state[i] = (this.state[i] + work[i]) >>> 0;
  }

  digestHex() {
    if (this.result !== null) return this.result;
    this.block[this.buffered++] = 0x80;
    this.block.fill(0, this.buffered);
    if (this.buffered > 56) {
      this._compress(this.block, 0);
      this.block.fill(0);
    }
    // Encode the 64-bit bit count without truncating the byte count to 32 bits.
    // File sizes and the accumulated byte count are exact safe JS integers.
    const view = new DataView(this.block.buffer);
    view.setUint32(56, Math.floor(this.byteLength / 0x20000000), false);
    view.setUint32(60, (this.byteLength % 0x20000000) * 8, false);
    this._compress(this.block, 0);
    this.result = Array.from(this.state, (word) => word.toString(16).padStart(8, '0')).join('');
    return this.result;
  }
}

function checkAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  throw new DOMException('Comparison cancelled.', 'AbortError');
}

function validateFile(file) {
  if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.slice !== 'function') {
    throw new TypeError('Choose two readable files.');
  }
}

async function readChunk(file, start, count) {
  if (start >= file.size) return new Uint8Array(0);
  const expected = Math.min(count, file.size - start);
  const bytes = new Uint8Array(await file.slice(start, start + expected).arrayBuffer());
  if (bytes.byteLength !== expected) throw new Error('A file could not be read completely. Choose the file again.');
  return bytes;
}

export const READ_SAMPLE_LIMIT = 65536;

export function normalizeExpectedHash(value) {
  if (typeof value !== 'string') return null;
  const hash = value.trim();
  return /^[0-9a-f]{64}$/i.test(hash) ? hash.toLowerCase() : null;
}

/** The real source offset represented by one ordered display sample. */
export function sampledByteOffset(size, index) {
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isInteger(index)
    || index < 0 || index >= Math.min(size, READ_SAMPLE_LIMIT)) {
    throw new RangeError('Choose an existing sample in a file with an exact byte size.');
  }
  if (size <= READ_SAMPLE_LIMIT) return index;
  // Quotient/remainder avoids an unsafe index * (size - 1) intermediate.
  // Both products and their sum remain exact safe integers at all File sizes.
  const denominator = READ_SAMPLE_LIMIT - 1;
  const quotient = Math.floor((size - 1) / denominator);
  const remainder = (size - 1) % denominator;
  return index * quotient + Math.floor(index * remainder / denominator);
}

/**
 * Compare Blob/File bytes and compute both whole-file SHA-256 fingerprints,
 * or verify one file against an expected fingerprint in place of file B.
 * firstDifference is a zero-based byte offset, or null for identical files.
 * A shorter matching prefix differs at the shorter file's length.
 * Progress keeps combined totals plus each file's processed bytes/percentage.
 * Empty files are individually already at 100%; empty + empty is also 100%.
 * onRead emits real sampled bytes immediately after each individual read,
 * before hashing or waiting for the other lane. Samples span the entire file,
 * include its final byte, and retain at most READ_SAMPLE_LIMIT bytes per file.
 * Errors and cancellation reject rather than returning a partial verdict.
 */
export async function compareFiles(fileA, fileB, { expectedHash, onProgress, onRead, signal, chunkSize = 2 * 1024 * 1024 } = {}) {
  validateFile(fileA);
  const checksum = normalizeExpectedHash(expectedHash);
  if (expectedHash != null) {
    if (!checksum || fileB != null) throw new TypeError('Provide one file and a 64-character SHA-256 hash.');
  } else {
    validateFile(fileB);
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 16 * 1024 * 1024) {
    throw new RangeError('Chunk size must be between 1 byte and 16 MiB.');
  }
  if (onProgress !== undefined && typeof onProgress !== 'function') {
    throw new TypeError('onProgress must be a function.');
  }
  if (onRead !== undefined && typeof onRead !== 'function') {
    throw new TypeError('onRead must be a function.');
  }
  const sizeB = fileB?.size ?? 0;
  const total = fileA.size + sizeB;
  if (!Number.isSafeInteger(total)) throw new RangeError('These files are too large to count bytes exactly.');
  const hashA = new IncrementalSHA256();
  const hashB = fileB ? new IncrementalSHA256() : null;
  const maxSize = Math.max(fileA.size, sizeB);
  let firstDifference = fileB && fileA.size !== sizeB ? Math.min(fileA.size, sizeB) : null;
  let processed = 0;
  let processedA = 0;
  let processedB = 0;
  const progress = () => onProgress?.({
    processed, total, percent: total ? (processed / total) * 100 : 100,
    processedA, processedB,
    percentA: fileA.size ? (processedA / fileA.size) * 100 : 100,
    percentB: checksum ? null : sizeB ? (processedB / sizeB) * 100 : 100,
  });
  checkAborted(signal);
  progress();
  let reading = true;
  const sampleIndices = { a: 0, b: 0 };
  const emitRead = (lane, file, offset, bytes) => {
    if (!reading) return;
    checkAborted(signal);
    if (!onRead) return;
    const sampleTotal = Math.min(file.size, READ_SAMPLE_LIMIT);
    const sampleStart = sampleIndices[lane];
    const end = offset + bytes.length;
    const sampleBytes = [];
    while (sampleIndices[lane] < sampleTotal) {
      const sourceOffset = sampledByteOffset(file.size, sampleIndices[lane]);
      if (sourceOffset >= end) break;
      sampleBytes.push(bytes[sourceOffset - offset]);
      sampleIndices[lane]++;
    }
    onRead({ lane, processed: end, total: file.size, sampleStart, sampleBytes, sampleTotal });
  };
  const readLane = async (lane, file, offset) => {
    const bytes = await readChunk(file, offset, chunkSize);
    if (offset < file.size) emitRead(lane, file, offset, bytes);
    return bytes;
  };
  try {
    // Empty files have no successful chunk read to report, but are already done.
    if (fileA.size === 0) emitRead('a', fileA, 0, new Uint8Array(0));
    if (fileB?.size === 0) emitRead('b', fileB, 0, new Uint8Array(0));
    for (let offset = 0; offset < maxSize; offset += chunkSize) {
      checkAborted(signal);
      const [a, b] = fileB ? await Promise.all([
        readLane('a', fileA, offset),
        readLane('b', fileB, offset),
      ]) : [await readLane('a', fileA, offset), null];
      checkAborted(signal);
      hashA.update(a);
      processedA += a.byteLength;
      if (b) {
        hashB.update(b);
        processedB += b.byteLength;
        const comparable = Math.min(a.byteLength, b.byteLength);
        if (firstDifference === null || offset < firstDifference) {
          for (let i = 0; i < comparable; i++) {
            if (a[i] !== b[i]) {
              firstDifference = offset + i;
              break;
            }
          }
        }
      }
      processed = processedA + processedB;
      progress();
    }
    checkAborted(signal);
    const actualHash = hashA.digestHex();
    if (checksum) {
      return {
        mode: 'hash', matches: actualHash === checksum, hashA: actualHash, hashB: checksum,
        sizeA: fileA.size, sizeB: null, firstDifference: null,
      };
    }
    return {
      identical: firstDifference === null,
      hashA: actualHash,
      hashB: hashB.digestHex(),
      sizeA: fileA.size,
      sizeB,
      firstDifference,
    };
  } finally {
    // A rejected/aborted sibling read must not later emit stale samples.
    reading = false;
  }
}
