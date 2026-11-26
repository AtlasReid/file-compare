// Pure explanation frames for an already-calculated SHA-256 message schedule.
// No file reads, animation timing or hashing state is changed by this module.

const isWord = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const hexWord = (value) => value.toString(16).padStart(8, '0');
const wordBytes = (word) => [(word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255];
const rotateRight = (word, count) => ((word >>> count) | (word << (32 - count))) >>> 0;
const sigma0 = (word) => (rotateRight(word, 7) ^ rotateRight(word, 18) ^ (word >>> 3)) >>> 0;
const sigma1 = (word) => (rotateRight(word, 17) ^ rotateRight(word, 19) ^ (word >>> 10)) >>> 0;

function validateBlock(block) {
  if (!block || !Array.isArray(block.words) || block.words.length !== 64
    || !block.words.every(isWord) || !Array.isArray(block.schedule) || block.schedule.length !== 64
    || !Array.isArray(block.bytes) || block.bytes.length !== 64
    || !block.bytes.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
    throw new TypeError('Provide one complete traced SHA-256 block.');
  }
}

/**
 * Return a read-only-by-copy explanation of one real schedule word.
 * Indices are zero-based. The first 16 words copy four consecutive block bytes;
 * later words combine four earlier words, with the two real small-sigma terms.
 *
 * `visibleWords` is an integer from 0 to 64. The active word must already be
 * visible. At count 0, only word 0 may be previewed: isVisible is then false,
 * while the remaining fields still contain that word's real numeric values.
 * Omitting activeWord selects the latest visible word (or preview word 0).
 */
export function scheduleFrame(block, visibleWords = 16, activeWord = Math.max(0, visibleWords - 1)) {
  validateBlock(block);
  if (!Number.isInteger(visibleWords) || visibleWords < 0 || visibleWords > 64) {
    throw new RangeError('The visible schedule count must be an integer from 0 to 64.');
  }
  if (!Number.isInteger(activeWord) || activeWord < 0 || activeWord > 63
    || (visibleWords === 0 ? activeWord !== 0 : activeWord >= visibleWords)) {
    throw new RangeError('Select a schedule word that is already visible.');
  }
  const result = block.words[activeWord];
  const entry = block.schedule[activeWord];
  if (!entry || entry.index !== activeWord || entry.value !== result || !Array.isArray(entry.sourceIndices)) {
    throw new TypeError('The selected schedule trace is inconsistent with its word.');
  }
  const isCopied = activeWord < 16;
  let sources;
  let operands;
  let formula;
  if (isCopied) {
    const offset = activeWord * 4;
    const bytes = block.bytes.slice(offset, offset + 4);
    const packed = (bytes[0] * 0x1000000 + bytes[1] * 0x10000 + bytes[2] * 0x100 + bytes[3]) >>> 0;
    if (packed !== result || entry.sourceIndices.length !== 0 || entry.sigma0 !== null || entry.sigma1 !== null) {
      throw new TypeError('Copied schedule words must match four original block bytes.');
    }
    sources = [];
    operands = [{ label: `bytes ${offset}–${offset + 3}`, sourceIndex: activeWord, value: result, operation: 'copy' }];
    formula = `W${activeWord} = pack(bytes ${offset}–${offset + 3}, most-significant byte first)`;
  } else {
    sources = [activeWord - 16, activeWord - 15, activeWord - 7, activeWord - 2];
    if (entry.sourceIndices.length !== 4 || !sources.every((source, index) => entry.sourceIndices[index] === source)) {
      throw new TypeError('Derived schedule words must use their four earlier source words.');
    }
    const values = [block.words[sources[0]], sigma0(block.words[sources[1]]), block.words[sources[2]], sigma1(block.words[sources[3]])];
    if (entry.sigma0 !== values[1] || entry.sigma1 !== values[3]
      || ((values[0] + values[1] + values[2] + values[3]) >>> 0) !== result) {
      throw new TypeError('The derived schedule trace has inconsistent sigma or addition values.');
    }
    operands = [
      { label: `W${sources[0]}`, sourceIndex: sources[0], value: values[0], operation: 'identity' },
      { label: `σ₀(W${sources[1]})`, sourceIndex: sources[1], value: values[1], operation: 'sigma0' },
      { label: `W${sources[2]}`, sourceIndex: sources[2], value: values[2], operation: 'identity' },
      { label: `σ₁(W${sources[3]})`, sourceIndex: sources[3], value: values[3], operation: 'sigma1' },
    ];
    formula = `W${activeWord} = ${operands.map((operand) => operand.label).join(' + ')} (mod 2³²)`;
  }
  return {
    visibleWords,
    activeWord,
    isVisible: visibleWords > 0,
    isCopied,
    sources,
    operands,
    result,
    hex: hexWord(result),
    bytes: isCopied ? block.bytes.slice(activeWord * 4, activeWord * 4 + 4) : wordBytes(result),
    binary: result.toString(2).padStart(32, '0'),
    formula,
  };
}
