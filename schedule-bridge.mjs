import { scheduleFrame } from './schedule-story.mjs';

const paddingKinds = new Set(['message', 'marker', 'zero', 'length']);

function tracedBlock(model, blockIndex) {
  if (!model || !Number.isSafeInteger(model.blockCount) || model.blockCount < 1
    || !Array.isArray(model.blocks)) {
    throw new TypeError('Provide an inspected file with traced SHA-256 blocks.');
  }
  if (!Number.isSafeInteger(blockIndex) || blockIndex < 0 || blockIndex >= model.blockCount) {
    throw new RangeError('Select a padded block within this file.');
  }
  const block = model.blocks[blockIndex];
  if (!block || block.index !== blockIndex) {
    throw new RangeError('The selected padded block has not been traced.');
  }
  // Every original word must still be the big-endian packing of its four
  // source bytes. This also checks the complete block/schedule array shapes.
  for (let word = 0; word < 16; word++) scheduleFrame(block, 16, word);
  return block;
}

/**
 * Isolate one actual 512-bit block before expanding its message schedule.
 * A large inspected file may expose only its first compression block; final
 * padding data alone does not make an untraced block available here.
 */
export function scheduleBlockData(model, blockIndex = 0) {
  const block = tracedBlock(model, blockIndex);
  let kinds = Array(64).fill('message');
  if (model.paddingBlocks != null) {
    if (!Array.isArray(model.paddingBlocks)) throw new TypeError('Padding blocks must be an array.');
    const matching = model.paddingBlocks.filter((padding) => padding?.index === blockIndex);
    if (matching.length > 1) throw new TypeError('A padded block must have one unambiguous source.');
    if (matching.length) {
      const padding = matching[0];
      if (!Array.isArray(padding.kinds) || padding.kinds.length !== 64
        || !padding.kinds.every((kind) => paddingKinds.has(kind))
        || !Array.isArray(padding.bytes) || padding.bytes.length !== 64
        || !padding.bytes.every((byte, offset) => byte === block.bytes[offset])) {
        throw new TypeError('Padding categories must describe the selected block bytes.');
      }
      kinds = padding.kinds.slice();
    }
  }
  return {
    values: block.bytes.slice(),
    kinds,
    sourceOffsets: Array.from({ length: 64 }, (_, offset) => block.index * 64 + offset),
    capacity: 64,
    unit: 'byte',
    index: blockIndex,
    blockCount: model.blockCount,
  };
}

/** Explain one of the first block's sixteen four-byte, 32-bit seed words. */
export function scheduleGroupingFrame(model, activeWord = 0) {
  if (!Number.isInteger(activeWord) || activeWord < 0 || activeWord > 15) {
    throw new RangeError('Select an original schedule word from 0 to 15.');
  }
  const block = tracedBlock(model, 0);
  const frame = scheduleFrame(block, 16, activeWord);
  return {
    blockIndex: 0,
    wordIndex: activeWord,
    sourceOffsets: Array.from({ length: 4 }, (_, offset) => activeWord * 4 + offset),
    bytes: frame.bytes,
    bits: Array.from(frame.binary, Number),
    word: frame.result,
    hex: frame.hex,
    bitCount: 512,
    wordCount: 16,
  };
}
