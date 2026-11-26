// Educational, byte-accurate SHA-256 trace. All indices are zero-based.
// FIPS 180-4 §5.1.1, §5.3.3 and §6.2. Retains intermediate values only for
// short inputs; the file-comparison engine remains separate and streaming.

export const INITIAL_STATE = Object.freeze([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
const CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const rotr = (word, count) => ((word >>> count) | (word << (32 - count))) >>> 0;
const small0 = (word) => (rotr(word, 7) ^ rotr(word, 18) ^ (word >>> 3)) >>> 0;
const small1 = (word) => (rotr(word, 17) ^ rotr(word, 19) ^ (word >>> 10)) >>> 0;
const big0 = (word) => (rotr(word, 2) ^ rotr(word, 13) ^ rotr(word, 22)) >>> 0;
const big1 = (word) => (rotr(word, 6) ^ rotr(word, 11) ^ rotr(word, 25)) >>> 0;

function validateBytes(input) {
  if (!(input instanceof Uint8Array)) throw new TypeError('Provide bytes as a Uint8Array.');
}

/**
 * Trace compression of exactly one already-formed 512-bit block. This helper
 * does not pad, finalize or claim to hash an entire file. With a file's first
 * 64 raw bytes and the default IV, it traces that file's first compression.
 * `initial` can be an eight-word Array or Uint32Array of unsigned integers.
 */
export function traceCompressionBlock(blockBytes, initial = INITIAL_STATE) {
  validateBytes(blockBytes);
  if (blockBytes.length !== 64) throw new RangeError('Compression needs exactly 64 bytes.');
  if (!(Array.isArray(initial) || initial instanceof Uint32Array)
    || initial.length !== 8 || !Array.from(initial).every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffffffff)) {
    throw new TypeError('The incoming hash must contain eight unsigned 32-bit words.');
  }
  initial = Array.from(initial);
  const view = new DataView(blockBytes.buffer, blockBytes.byteOffset, blockBytes.byteLength);
  const words = [];
  const schedule = [];
  for (let t = 0; t < 16; t++) {
    const value = view.getUint32(t * 4, false);
    words.push(value);
    schedule.push({ index: t, value, sourceIndices: [], sigma0: null, sigma1: null });
  }
  for (let t = 16; t < 64; t++) {
    const sigma0 = small0(words[t - 15]);
    const sigma1 = small1(words[t - 2]);
    const value = (words[t - 16] + sigma0 + words[t - 7] + sigma1) >>> 0;
    words.push(value);
    schedule.push({ index: t, value, sourceIndices: [t - 16, t - 15, t - 7, t - 2], sigma0, sigma1 });
  }
  let working = initial.slice();
  const rounds = [];
  for (let t = 0; t < 64; t++) {
    const before = working.slice();
    const [a, b, c, d, e, f, g, h] = before;
    const sigma0 = big0(a);
    const sigma1 = big1(e);
    const choose = ((e & f) ^ (~e & g)) >>> 0;
    const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
    const w = words[t];
    const k = CONSTANTS[t];
    const t1 = (h + sigma1 + choose + k + w) >>> 0;
    const t2 = (sigma0 + majority) >>> 0;
    working = [(t1 + t2) >>> 0, a, b, c, (d + t1) >>> 0, e, f, g];
    rounds.push({ index: t, before, after: working.slice(), w, k, sigma0, sigma1, choose, majority, t1, t2 });
  }
  const workingFinal = working.slice();
  const output = initial.map((value, i) => (value + workingFinal[i]) >>> 0);
  return { index: 0, bytes: Array.from(blockBytes), words, schedule, initial, rounds, workingFinal, output };
}

/**
 * Return plain arrays/objects for rendering. Round sigma0/sigma1 are the upper
 * case Σ0(a)/Σ1(e); schedule sigma0/sigma1 are lower case σ0(W[t−15])/σ1(W[t−2]).
 * All word values, including Boolean-function intermediates, are unsigned.
 */
export function traceSHA256(input) {
  validateBytes(input);
  if (input.length > 4096) throw new RangeError('The walkthrough accepts at most 4096 input bytes.');
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  let state = INITIAL_STATE.slice();
  const blocks = [];

  for (let offset = 0; offset < paddedLength; offset += 64) {
    const block = traceCompressionBlock(padded.subarray(offset, offset + 64), state);
    block.index = offset / 64;
    blocks.push(block);
    state = block.output.slice();
  }
  return {
    bytes: Array.from(input),
    padded: Array.from(padded),
    bitLength,
    blocks,
    digest: state.map((word) => word.toString(16).padStart(8, '0')).join(''),
  };
}

/** Return a copy with one input bit toggled. Bit 0 is the first byte's MSB. */
export function flipInputBit(input, bitIndex = 0) {
  validateBytes(input);
  if (!Number.isInteger(bitIndex) || bitIndex < 0 || bitIndex >= input.length * 8) {
    throw new RangeError('Choose an existing input bit. Empty inputs have no bit to flip.');
  }
  const result = new Uint8Array(input);
  result[Math.floor(bitIndex / 8)] ^= 1 << (7 - (bitIndex % 8));
  return result;
}

/** Count differing bits between two equal-length byte arrays. */
export function hammingDistance(a, b) {
  validateBytes(a);
  validateBytes(b);
  if (a.length !== b.length) throw new RangeError('Bit distance requires equal-length byte arrays.');
  let count = 0;
  for (let i = 0; i < a.length; i++) {
    let difference = a[i] ^ b[i];
    while (difference) { difference &= difference - 1; count++; }
  }
  return count;
}
