// Pure data for the two SHA-256 voxel lanes. Bits are always most-significant
// first, matching the displayed byte/word order. Ghost voxels have bit 0 and
// kind `absent`; they never stand for actual zero bits in a file.

const STAGES = ['bytes', 'padding', 'schedule', 'rounds', 'digest'];
const COUNTS = { bytes: 512, padding: 512, schedule: 2048, rounds: 256, digest: 256 };
const absent = (count) => ({ bits: Array(count).fill(0), kinds: Array(count).fill('absent') });

function byteBits(values, kinds) {
  const bits = [];
  const bitKinds = [];
  values.forEach((value, index) => {
    if (!Number.isInteger(value) || value < 0 || value > 255) throw new TypeError('Voxel bytes must be unsigned 8-bit integers.');
    for (let bit = 7; bit >= 0; bit--) { bits.push((value >>> bit) & 1); bitKinds.push(kinds[index]); }
  });
  return { bits, kinds: bitKinds };
}

function wordBits(values, kinds) {
  const bits = [];
  const bitKinds = [];
  values.forEach((value, index) => {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new TypeError('Voxel words must be unsigned 32-bit integers.');
    for (let bit = 31; bit >= 0; bit--) { bits.push((value >>> bit) & 1); bitKinds.push(kinds[index]); }
  });
  return { bits, kinds: bitKinds };
}

/**
 * Build a selected block's stage voxels from inspectFile() data. Numeric stages
 * 0..4 are accepted as aliases for bytes/padding/schedule/rounds/digest.
 *
 * Padding shows the first of the file's final padding blocks. `digest` means
 * the selected block's feed-forward output, which may be INTERMEDIATE. Build
 * the merged final comparison from digestBits(the worker's full-file hash),
 * never from an inspected prefix or an intermediate compression block.
 */
export function buildVoxelData(model, stage, round = 0, blockIndex = 0) {
  if (Number.isInteger(stage)) stage = STAGES[stage];
  if (!STAGES.includes(stage)) throw new RangeError('Choose a recognized SHA-256 voxel stage.');
  if (!model || !Array.isArray(model.blocks) || !Number.isSafeInteger(model.size) || model.size < 0) {
    throw new TypeError('Provide a file inspection model.');
  }
  if (!Number.isInteger(blockIndex) || blockIndex < 0) throw new RangeError('Choose a non-negative compression block index.');
  if (stage === 'rounds' && (!Number.isInteger(round) || round < 0 || round > 64)) {
    throw new RangeError('Round must be an integer from 0 through 64.');
  }
  const block = model.blocks[blockIndex];
  if (stage === 'padding') {
    const padding = model.paddingBlocks?.[0];
    if (!padding) return absent(COUNTS.padding);
    return byteBits(padding.bytes, padding.kinds);
  }
  if (!block) return absent(COUNTS[stage]);
  if (stage === 'bytes') {
    const count = Math.max(0, Math.min(64, model.size - blockIndex * 64));
    const data = byteBits(block.bytes.slice(0, count), Array(count).fill('message'));
    while (data.bits.length < COUNTS.bytes) { data.bits.push(0); data.kinds.push('absent'); }
    return data;
  }
  if (stage === 'schedule') return wordBits(block.words, block.words.map((_, index) => index < 16 ? 'message' : 'schedule'));
  if (stage === 'rounds') {
    const words = round === 0 ? block.initial : block.rounds[round - 1].after;
    return wordBits(words, Array(8).fill('state'));
  }
  return wordBits(block.output, Array(8).fill('digest'));
}

/** The complete SHA-256 hash is exactly 64 hex characters / 256 bits. */
export function digestBits(value) {
  if (typeof value !== 'string') throw new TypeError('Provide a SHA-256 hexadecimal digest.');
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new RangeError('A SHA-256 digest must contain exactly 64 hexadecimal characters.');
  return Array.from(value, (digit) => {
    const nibble = parseInt(digit, 16);
    return [(nibble >>> 3) & 1, (nibble >>> 2) & 1, (nibble >>> 1) & 1, nibble & 1];
  }).flat();
}
