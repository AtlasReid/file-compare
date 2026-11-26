// Pure presentation data for two complete SHA-256 digests. Character colors
// summarize their four actual bits; no file reading or hashing happens here.
function normalizedHash(hash) {
  if (typeof hash !== 'string' || hash.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hash)) {
    throw new TypeError('Provide a complete SHA-256 digest as exactly 64 hexadecimal characters.');
  }
  return hash.toLowerCase();
}

/** Compare full digests in left-to-right, most-significant-bit-first order. */
export function hashComparison(hashA, hashB) {
  const a = normalizedHash(hashA), b = normalizedHash(hashB);
  const bits = [], digits = [];
  let differentBits = 0;
  for (let index = 0; index < 64; index++) {
    const binaryA = parseInt(a[index], 16).toString(2).padStart(4, '0');
    const binaryB = parseInt(b[index], 16).toString(2).padStart(4, '0');
    let mask = '', digitDifferences = 0;
    for (let bit = 0; bit < 4; bit++) {
      const valueA = Number(binaryA[bit]), valueB = Number(binaryB[bit]);
      const different = valueA !== valueB;
      bits.push({ index: index * 4 + bit, a: valueA, b: valueB, different });
      mask += different ? '1' : '0';
      digitDifferences += Number(different);
    }
    differentBits += digitDifferences;
    digits.push({ index, a: a[index], b: b[index], startBit: index * 4, endBit: index * 4 + 3,
      different: digitDifferences > 0, differentBits: digitDifferences, mask, binaryA, binaryB });
  }
  return { a, b, differentBits, bits, digits };
}
