import { inspectFile } from './sha256-file-model.mjs';
import { digestBits } from './voxel-model.mjs';

const SAMPLE_LIMIT = 65536;
const STAGES = ['bytes', 'padding', 'schedule', 'rounds', 'digest'];

function checkAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason !== undefined ? signal.reason : new DOMException('Inspection cancelled.', 'AbortError');
}

async function inspectLane(file, signal) {
  const model = await inspectFile(file, { signal });
  checkAborted(signal);
  let sampleBytes;
  if (model.completeTrace) {
    // The complete small-file trace already contains every original byte.
    sampleBytes = model.blocks.flatMap((block) => block.bytes).slice(0, model.size);
  } else {
    const count = Math.min(model.size, SAMPLE_LIMIT);
    const part = file.slice(0, count);
    if (!part || typeof part.arrayBuffer !== 'function') throw new TypeError('The point sample cannot read this file.');
    const buffer = await part.arrayBuffer();
    checkAborted(signal);
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== count) {
      throw new Error('The point sample could not be read completely. Choose the file again.');
    }
    sampleBytes = Array.from(new Uint8Array(buffer));
  }
  checkAborted(signal);
  return { ...model, sampleBytes, sampled: model.size > SAMPLE_LIMIT };
}

/**
 * Independently inspect both real files. Each large-file point sample is capped
 * at 65,536 prefix bytes; its compression/padding inspection still uses only
 * the first block and final partial block. Full hashes are supplied separately
 * by the comparison worker, never inferred from these samples.
 */
export async function inspectPointFiles(fileA, fileB, { signal } = {}) {
  checkAborted(signal);
  const [a, b] = await Promise.all([inspectLane(fileA, signal), inspectLane(fileB, signal)]);
  checkAborted(signal);
  return { a, b };
}

function validateModel(model) {
  if (!model || !Array.isArray(model.blocks) || !Array.isArray(model.sampleBytes) || !Array.isArray(model.paddingBlocks)) {
    throw new TypeError('Provide a point-file inspection model.');
  }
}

function wordsAsBytes(words) {
  return words.flatMap((value) => {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new TypeError('SHA-256 words must be unsigned 32-bit integers.');
    return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  });
}

function wordsAsBits(words) {
  return wordsAsBytes(words).flatMap((value) => Array.from({ length: 8 }, (_, index) => (value >>> (7 - index)) & 1));
}

/**
 * File, padding and round-state points represent bytes. The schedule exposes
 * each word's 32 bits so all 64 words fill a balanced 16×16×8 bit lattice.
 * Final digests also use one point per bit.
 * The rounds stage always returns all 64 layers (32 bytes each); `round` is a
 * renderer visibility position, not a request to drop later layers. No missing
 * compression block is replaced by another block or synthetic zero values.
 */
export function stagePointData(model, stage, round = 64, blockIndex = 0, fullHash = null) {
  validateModel(model);
  if (Number.isInteger(stage)) stage = STAGES[stage];
  if (![...STAGES, 'compare'].includes(stage)) throw new RangeError('Choose a recognized SHA-256 point stage.');
  if (!Number.isInteger(round) || round < 0 || round > 64) throw new RangeError('Round visibility must be an integer from 0 through 64.');
  if (!Number.isInteger(blockIndex) || blockIndex < 0) throw new RangeError('Choose a non-negative compression block index.');
  if (stage === 'digest' || stage === 'compare') {
    if (fullHash === null || fullHash === undefined) throw new TypeError('The final point comparison requires the complete-file SHA-256 digest.');
    const values = digestBits(fullHash);
    return { values, kinds: Array(values.length).fill('digest'), unit: 'bit' };
  }
  if (stage === 'bytes') {
    return { values: model.sampleBytes.slice(), kinds: Array(model.sampleBytes.length).fill('message'), unit: 'byte' };
  }
  if (stage === 'padding') {
    // Retain every displayed original byte in place, then append only bytes
    // added by SHA-256 padding. The inspection tail also contains original
    // remainder bytes, so remove those before appending to avoid duplication.
    const remainder = model.size % 64;
    const addedBytes = model.paddingBlocks.flatMap((block) => block.bytes).slice(remainder);
    const addedKinds = model.paddingBlocks.flatMap((block) => block.kinds).slice(remainder);
    return {
      values: [...model.sampleBytes, ...addedBytes],
      kinds: [...Array(model.sampleBytes.length).fill('message'), ...addedKinds],
      unit: 'byte',
      paddingStart: model.sampleBytes.length,
      paddingAdded: addedBytes.length,
    };
  }
  const block = model.blocks[blockIndex];
  if (!block) return { values: [], kinds: [], unit: stage === 'schedule' ? 'bit' : 'byte' };
  if (stage === 'schedule') {
    const values = wordsAsBits(block.words);
    return { values, kinds: values.map((_, index) => index < 512 ? 'message' : 'schedule'), unit: 'bit' };
  }
  const values = block.rounds.flatMap((step) => wordsAsBytes(step.after));
  return { values, kinds: Array(values.length).fill('state'), unit: 'byte' };
}
